import { VERSION, createServer, type ServerOptions } from '@payground/server';
import { FAILURE, OK, USAGE_ERROR, flag, integer, parseOptions, text } from '../args.ts';
import { DEFAULT_DB, type Env } from '../env.ts';

export const START_USAGE = `Usage: payground start [options]

  --port <n>       Port to listen on (default 8080, env PAYGROUND_PORT)
  --host <addr>    Address to bind (default 127.0.0.1, env PAYGROUND_HOST)
  --db <path>      SQLite file, or :memory: (default ${DEFAULT_DB}, env PAYGROUND_DB)
  --base-url <url> Public origin used in tickets and QR codes (env PAYGROUND_BASE_URL)
  --no-bootstrap   Start without creating a default sandbox
  -h, --help       Show this help`;

const DASHBOARD_PATH = '/_payground/dashboard/';

function label(name: string, value: string): string {
  return `  ${name.padEnd(15)} ${value}`;
}

export async function runStart(argv: readonly string[], env: Env): Promise<number> {
  const parsed = parseOptions(argv, {
    port: { type: 'string' },
    host: { type: 'string' },
    db: { type: 'string' },
    'base-url': { type: 'string' },
    'no-bootstrap': { type: 'boolean' },
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
  const baseUrl = text(parsed.values, 'base-url') ?? env.variables['PAYGROUND_BASE_URL'];

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
  const dashboardServed = Object.keys(server.app.routes).some((route) => route.startsWith(DASHBOARD_PATH));
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
    label(
      'dashboard',
      `${origin}${DASHBOARD_PATH}${dashboardServed ? '' : '  (not served yet — run `payground build-dashboard`)'}`,
    ),
  );
  env.io.out(label('health', `${origin}/_payground/health`));

  await env.waitForShutdown(origin);

  await server.stop(true);
  storage.close();
  env.io.out('payground stopped');
  return OK;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
