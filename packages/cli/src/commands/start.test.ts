import { describe, expect, test } from 'bun:test';
import { main } from '../index.ts';
import { testEnv } from '../testing.ts';

describe('start', () => {
  test('serves health and reports the credentials', async () => {
    const { env, out } = testEnv();
    let health: unknown;
    env.waitForShutdown = async (url) => {
      health = await (await fetch(`${url}/_payground/health`)).json();
    };

    expect(await main(['start', '--port', '0', '--db', ':memory:'], env)).toBe(0);
    expect(health).toMatchObject({ status: 'ok' });
    expect(out[0]).toContain('listening on http://127.0.0.1:');
    expect(out.join('\n')).toContain('access token    TEST-');
    expect(out.join('\n')).toContain('webhook secret');
    expect(out.at(-1)).toBe('payground stopped');
  });

  test('--no-bootstrap starts without a sandbox', async () => {
    const { env, out, storage } = testEnv();
    expect(await main(['start', '--port', '0', '--no-bootstrap'], env)).toBe(0);
    expect(out.join('\n')).toContain('none (--no-bootstrap)');
    expect(storage.sandboxes.list()).toHaveLength(0);
  });

  test('--strict validates the bodies it is sent', async () => {
    const { env, out } = testEnv();
    let rejected: { status: number; body: { error?: string } } | null = null;
    env.waitForShutdown = async (url) => {
      const response = await fetch(`${url}/v1/payments`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${(out.join('\n').match(/access token\s+(TEST-\S+)/) ?? [])[1] ?? ''}`,
          'x-idempotency-key': 'k',
        },
        body: JSON.stringify({ transaction_amount: 1, payment_method_id: 'pix', payer: { email: 'a@b.c' }, nope: 1 }),
      });
      rejected = { status: response.status, body: (await response.json()) as { error?: string } };
    };

    expect(await main(['start', '--port', '0', '--db', ':memory:', '--strict'], env)).toBe(0);
    expect(out.join('\n')).toContain('strict mode     on');
    expect(rejected).toMatchObject({ status: 400, body: { error: 'bad_request' } });
  });

  test('reads the port from the environment', async () => {
    const { env } = testEnv({ variables: { PAYGROUND_PORT: 'abc' } });
    expect(await main(['start'], env)).toBe(2);
  });

  test('fails when the requested dashboard directory holds no assets', async () => {
    const { env, err } = testEnv();
    expect(await main(['start', '--port', '0', '--dashboard', '/tmp/payground-no-dashboard'], env)).toBe(1);
    expect(err[0]).toContain('no dashboard assets in /tmp/payground-no-dashboard');
  });

  test('rejects an invalid port', async () => {
    const { env, err } = testEnv();
    expect(await main(['start', '--port', '70000'], env)).toBe(2);
    expect(err[0]).toContain('--port must be an integer');
  });

  test('fails when the port is already taken', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('busy') });
    try {
      const { env, err } = testEnv();
      expect(await main(['start', '--port', String(server.port)], env)).toBe(1);
      expect(err[0]).toContain('cannot listen on');
    } finally {
      await server.stop(true);
    }
  });
});
