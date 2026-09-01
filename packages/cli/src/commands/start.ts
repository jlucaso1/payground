import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RateLimiter } from '@payground/core';
import { VERSION, createServer, createTokenBucketLimiter, type ServerOptions } from '@payground/server';
import { type Retention, startRetention } from '@payground/server/maintenance.ts';
import { FAILURE, OK, USAGE_ERROR, flag, integer, parseOptions, text, type Values } from '../args.ts';
import { DEFAULT_DB, type Env, MEMORY } from '../env.ts';

export const START_USAGE = `Usage: payground start [options]

  --port <n>       Port to listen on (default 8080, env PAYGROUND_PORT)
  --host <addr>    Address to bind (default 127.0.0.1, env PAYGROUND_HOST)
  --db <path>      SQLite file, or :memory: (default ${DEFAULT_DB}, env PAYGROUND_DB)
  --base-url <url> Public origin used in tickets and QR codes (env PAYGROUND_BASE_URL)
  --dashboard <dir> Prebuilt dashboard assets (env PAYGROUND_DASHBOARD)
  --admin-token <t> Token required by the control API (env PAYGROUND_ADMIN_TOKEN).
                   Generated and printed when omitted; --no-admin-token disables it
  --no-admin-token Leave the control API open (only safe on a private instance)
  --no-bootstrap   Start without creating a default sandbox
  --rate-limit <n> Requests per second allowed per sandbox (env PAYGROUND_RATE_LIMIT).
                   Off by default; enable it on a shared instance
  --rate-burst <n> Requests a sandbox may spend at once (env PAYGROUND_RATE_BURST,
                   default: one second of --rate-limit)
  --no-rate-limit  Disable throttling even when the environment configures it
  --retention-days <n>
                   Prune requests, audit, webhooks and payments older than n days,
                   on boot and hourly after that (env PAYGROUND_RETENTION_DAYS)
  --block-private-webhooks
                   Refuse webhook targets on private addresses (public deployments)
  -h, --help       Show this help`;

const DASHBOARD_PATH = '/_payground';

/**
 * The bundled CLI ships its assets in dist/dashboard next to itself; from a source
 * checkout `bun run build:dashboard` writes them to packages/cli/dist/dashboard.
 */
function findDashboard(explicit: string | undefined, variables: Record<string, string | undefined>): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = explicit === undefined
    ? [
        variables['PAYGROUND_DASHBOARD'],
        join(here, 'dashboard'),
        join(here, '..', 'dist', 'dashboard'),
        join(here, '..', '..', 'dist', 'dashboard'),
        'packages/cli/dist/dashboard',
        'dist/dashboard',
        'packages/dashboard/dist',
      ]
    : [explicit];
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

const MAX_RATE = 1_000_000;

interface RateLimit {
  limiter: RateLimiter;
  ratePerSecond: number;
  burst: number;
}

type Resolved = { ok: true; value: RateLimit | null } | { ok: false; message: string };

const setting = (raw: string | undefined): string | undefined => (raw === undefined || raw.trim() === '' ? undefined : raw);

/** Off unless asked for: a self-hosted instance has a single user and no reason to throttle. */
function resolveRateLimit(
  values: Values,
  variables: Record<string, string | undefined>,
): Resolved {
  if (flag(values, 'no-rate-limit')) return { ok: true, value: null };
  // An unexpanded `PAYGROUND_RATE_LIMIT: ${VAR}` in a compose file must leave it off,
  // not refuse to start.
  const rateRaw = setting(text(values, 'rate-limit') ?? variables['PAYGROUND_RATE_LIMIT']);
  const burstRaw = setting(text(values, 'rate-burst') ?? variables['PAYGROUND_RATE_BURST']);
  if (rateRaw === undefined) {
    return burstRaw === undefined
      ? { ok: true, value: null }
      : { ok: false, message: '--rate-burst needs --rate-limit' };
  }

  const rate = integer(rateRaw, 'rate-limit', 1, MAX_RATE);
  if (!rate.ok) return rate;
  const burst = burstRaw === undefined ? rate : integer(burstRaw, 'rate-burst', 1, MAX_RATE);
  if (!burst.ok) return burst;

  const limiter = createTokenBucketLimiter({ ratePerSecond: rate.value, burst: burst.value });
  if (!limiter.ok) return { ok: false, message: limiter.error };
  return { ok: true, value: { limiter: limiter.value, ratePerSecond: rate.value, burst: burst.value } };
}

function label(name: string, value: string): string {
  return `  ${name.padEnd(15)} ${value}`;
}

export async function runStart(argv: readonly string[], env: Env): Promise<number> {
  const parsed = parseOptions(argv, {
    port: { type: 'string' },
    host: { type: 'string' },
    db: { type: 'string' },
    'base-url': { type: 'string' },
    dashboard: { type: 'string' },
    'admin-token': { type: 'string' },
    'no-admin-token': { type: 'boolean' },
    'no-bootstrap': { type: 'boolean' },
    'retention-days': { type: 'string' },
    'block-private-webhooks': { type: 'boolean' },
    'rate-limit': { type: 'string' },
    'rate-burst': { type: 'string' },
    'no-rate-limit': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  });
  if (!parsed.ok) {
    env.io.err(parsed.message);
    env.io.err(START_USAGE);
    return USAGE_ERROR;
  }
  if (flag(parsed.values, 'help')) {
    env.io.out(START_USAGE);
    return OK;
  }

  const portRaw = text(parsed.values, 'port') ?? env.variables['PAYGROUND_PORT'] ?? '8080';
  const port = integer(portRaw, 'port', 0, 65535);
  if (!port.ok) {
    env.io.err(port.message);
    return USAGE_ERROR;
  }
  const retentionRaw = text(parsed.values, 'retention-days') ?? env.variables['PAYGROUND_RETENTION_DAYS'];
  let retentionDays: number | null = null;
  if (retentionRaw !== undefined) {
    const days = integer(retentionRaw, 'retention-days', 1, 3650);
    if (!days.ok) {
      env.io.err(days.message);
      return USAGE_ERROR;
    }
    retentionDays = days.value;
  }
  const host = text(parsed.values, 'host') ?? env.variables['PAYGROUND_HOST'] ?? '127.0.0.1';
  const db = text(parsed.values, 'db') ?? env.variables['PAYGROUND_DB'] ?? DEFAULT_DB;
  // Pix payloads and ticket URLs embed this origin. A wildcard bind is not addressable,
  // so fall back to loopback; port 0 is only known after listening, so leave the default.
  const advertised = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const baseUrl =
    text(parsed.values, 'base-url') ??
    env.variables['PAYGROUND_BASE_URL'] ??
    (port.value === 0 ? undefined : `http://${advertised}:${port.value}`);

  const requested = text(parsed.values, 'dashboard');
  const dashboardRoot = findDashboard(requested, env.variables);
  if (requested !== undefined && dashboardRoot === null) {
    env.io.err(`no dashboard assets in ${requested}; run \`payground build-dashboard --out ${requested}\``);
    return FAILURE;
  }

  const rateLimit = resolveRateLimit(parsed.values, env.variables);
  if (!rateLimit.ok) {
    env.io.err(rateLimit.message);
    return USAGE_ERROR;
  }

  // A shared instance must not expose sandbox credentials, so the token is on by default.
  const adminToken = flag(parsed.values, 'no-admin-token')
    ? null
    : (text(parsed.values, 'admin-token') ?? env.variables['PAYGROUND_ADMIN_TOKEN'] ?? crypto.randomUUID());

  let storage;
  try {
    storage = env.openStorage(db);
  } catch (error) {
    env.io.err(`cannot open the database at ${db}: ${message(error)}`);
    return FAILURE;
  }

  const options: ServerOptions = {
    port: port.value,
    hostname: host,
    storage,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(dashboardRoot === null ? {} : { dashboardRoot }),
    adminToken,
    ...(flag(parsed.values, 'block-private-webhooks') ? { allowPrivateWebhookTargets: false } : {}),
    ...(flag(parsed.values, 'no-bootstrap') ? { bootstrap: false as const } : {}),
    ...(rateLimit.value === null ? {} : { rateLimiter: rateLimit.value.limiter }),
  };

  let server: ReturnType<typeof createServer>;
  try {
    server = createServer(options);
  } catch (error) {
    env.io.err(`cannot listen on ${host}:${port.value}: ${message(error)}`);
    storage.close();
    return FAILURE;
  }

  const origin = server.url.origin;
  const sandbox = server.app.defaultSandbox;

  env.io.out(`payground ${VERSION} listening on ${origin}`);
  env.io.out(label('database', db));
  if (sandbox === null) {
    env.io.out(label('sandbox', 'none (--no-bootstrap)'));
  } else {
    env.io.out(label('sandbox', `${sandbox.id} (${sandbox.name})`));
    env.io.out(label('access token', sandbox.accessToken));
    env.io.out(label('public key', sandbox.publicKey));
    env.io.out(label('webhook secret', sandbox.webhookSecret));
  }
  env.io.out(
    dashboardRoot === null
      ? label('dashboard', 'not served — run `payground build-dashboard`')
      : label('dashboard', `${origin}${DASHBOARD_PATH}`),
  );
  env.io.out(
    adminToken === null
      ? label('admin token', 'disabled — the control API is open')
      : label('admin token', adminToken),
  );
  env.io.out(
    rateLimit.value === null
      ? label('rate limit', 'off')
      : label('rate limit', `${rateLimit.value.ratePerSecond}/s per sandbox, burst ${rateLimit.value.burst}`),
  );
  env.io.out(label('health', `${origin}/_payground/health`));

  let retention: Retention | null = null;
  let retentionDb: ReturnType<Env['openDatabase']> | null = null;
  if (retentionDays !== null) {
    if (db === MEMORY) {
      env.io.out(label('retention', `disabled — ${MEMORY} keeps nothing to prune`));
    } else {
      try {
        retentionDb = env.openDatabase(db);
      } catch (error) {
        env.io.err(`cannot open the database at ${db} for retention: ${message(error)}`);
        await server.stop(true);
        storage.close();
        return FAILURE;
      }
      const days = retentionDays;
      retention = startRetention(retentionDb, {
        clock: { now: () => env.now() },
        days,
        onPrune: (report) => {
          if (report.total > 0) env.io.out(`pruned ${report.total} rows older than ${days} days`);
        },
        onError: (reason) => env.io.err(`retention failed: ${reason}`),
      });
      env.io.out(label('retention', `${days} days`));
      retention.runNow();
    }
  }

  await env.waitForShutdown(origin);

  retention?.stop();
  retentionDb?.close();
  await server.stop(true);
  storage.close();
  env.io.out('payground stopped');
  return OK;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
