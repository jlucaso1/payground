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

  test('reads the port from the environment', async () => {
    const { env } = testEnv({ variables: { PAYGROUND_PORT: 'abc' } });
    expect(await main(['start'], env)).toBe(2);
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
