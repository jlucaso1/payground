import { ManualClock, SeededIdGenerator, SeededRandom } from '@payground/core/testing.ts';
import { Storage } from '@payground/storage';
import { MetricsRegistry } from './metrics/index.ts';
import { type ServerOptions, createServer } from './server.ts';

export const TEST_ACCESS_TOKEN = 'TEST-access-token';
export const TEST_PUBLIC_KEY = 'TEST-public-key';
export const TEST_WEBHOOK_SECRET = 'test-webhook-secret';
export const TEST_ADMIN_TOKEN = 'test-admin-token';
export const TEST_NOW = 1_700_000_000_000;

export interface Call<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface TestServer {
  origin: string;
  clock: ManualClock;
  metrics: MetricsRegistry;
  storage: Storage;
  server: ReturnType<typeof createServer>;
  sandboxId: string;
  /** Calls the emulated Mercado Pago surface with the sandbox access token. */
  api(method: string, path: string, init?: { body?: unknown; token?: string | null; key?: string | null }): Promise<Call>;
  /** Calls the control API with the admin token. */
  control(method: string, path: string, body?: unknown, token?: string | null): Promise<Call>;
  raw(path: string, init?: RequestInit): Promise<Response>;
  drainWebhooks(): Promise<number>;
  stop(): Promise<void>;
}

/**
 * One harness for every server test, so a test never has to reinvent bootstrapping.
 * Time, ids and randomness are all deterministic; webhook delivery is driven by the test.
 */
export function startTestServer(options: Partial<ServerOptions> = {}): TestServer {
  const clock = new ManualClock(TEST_NOW);
  const metrics = new MetricsRegistry();
  const storage = options.storage ?? Storage.open();

  const server = createServer({
    port: 0,
    clock,
    storage,
    metrics,
    ids: new SeededIdGenerator(),
    random: new SeededRandom(1),
    deliveryIntervalMs: 0,
    adminToken: TEST_ADMIN_TOKEN,
    bootstrap: {
      accessToken: TEST_ACCESS_TOKEN,
      publicKey: TEST_PUBLIC_KEY,
      webhookSecret: TEST_WEBHOOK_SECRET,
    },
    ...options,
  });

  const origin = server.url.origin;

  const read = async (response: Response): Promise<Call> => {
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      /* a ticket or checkout page is HTML, not JSON */
    }
    return { status: response.status, body, headers: response.headers };
  };

  return {
    origin,
    clock,
    metrics,
    storage,
    server,
    sandboxId: server.app.defaultSandbox?.id ?? '',

    async api(method, path, init = {}) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const token = init.token === undefined ? TEST_ACCESS_TOKEN : init.token;
      if (token !== null) headers['authorization'] = `Bearer ${token}`;
      const key = init.key === undefined ? crypto.randomUUID() : init.key;
      if (key !== null) headers['x-idempotency-key'] = key;

      return read(
        await fetch(`${origin}${path}`, {
          method,
          headers,
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        }),
      );
    },

    async control(method, path, body, token = TEST_ADMIN_TOKEN) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (token !== null) headers['authorization'] = `Bearer ${token}`;
      return read(
        await fetch(`${origin}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    },

    raw: (path, init) => fetch(`${origin}${path}`, init),
    drainWebhooks: () => server.app.drainWebhooks(),

    async stop() {
      await server.stop(true);
    },
  };
}

/** A receiver for webhook delivery tests. Records the headers and parsed body it sees. */
export function startReceiver(status = 200) {
  const received: { headers: Record<string, string>; body: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      const text = await request.text();
      received.push({
        headers: Object.fromEntries(request.headers.entries()),
        body: text === '' ? null : JSON.parse(text),
      });
      return new Response('ok', { status });
    },
  });

  return {
    url: `${server.url.origin}/hook`,
    received,
    stop: async () => {
      await server.stop(true);
    },
  };
}
