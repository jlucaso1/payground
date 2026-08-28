import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, createServer, type ServerOptions } from '@payground/server';
import { FAILURE, OK, USAGE_ERROR, flag, integer, parseOptions, text } from '../args.ts';
import { DEFAULT_DB, type Env } from '../env.ts';

export const START_USAGE = `Usage: payground start [options]

  --port <n>       Port to listen on (default 8080, env PAYGROUND_PORT)
  --host <addr>    Address to bind (default 127.0.0.1, env PAYGROUND_HOST)
  --db <path>      SQLite file, or :memory: (default ${DEFAULT_DB}, env PAYGROUND_DB)
  --base-url <url> Public origin used in tickets and QR codes (env PAYGROUND_BASE_URL)
  --dashboard <dir> Prebuilt dashboard assets (env PAYGROUND_DASHBOARD)
  --no-bootstrap   Start without creating a default sandbox
  --block-private-webhooks
                   Refuse webhook targets on private addresses (public deployments)
  -h, --help       Show this help`;

const DASHBOARD_PATH = '/_payground';

/** The bundled CLI ships its assets in dist/dashboard, next to itself. */
function findDashboard(explicit: string | undefined, variables: Record<string, string | undefined>): string | null {
  const beside = join(dirname(fileURLToPath(import.meta.url)), 'dashboard');
  const candidates = explicit === undefined
    ? [variables['PAYGROUND_DASHBOARD'], beside, 'dist/dashboard', 'packages/dashboard/dist']
    : [explicit];
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
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
    'no-bootstrap': { type: 'boolean' },
    'block-private-webhooks': { type: 'boolean' },
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
    ...(flag(parsed.values, 'block-private-webhooks') ? { allowPrivateWebhookTargets: false } : {}),
    ...(flag(parsed.values, 'no-bootstrap') ? { bootstrap: false as const } : {}),
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
  env.io.out(label('health', `${origin}/_payground/health`));

  await env.waitForShutdown(origin);

  await server.stop(true);
  storage.close();
  env.io.out('payground stopped');
  return OK;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
