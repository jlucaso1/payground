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

  test('fails when the requested dashboard directory holds no assets', async () => {
    const { env, err } = testEnv();
    expect(await main(['start', '--port', '0', '--dashboard', '/tmp/payground-no-dashboard'], env)).toBe(1);
    expect(err[0]).toContain('no dashboard assets in /tmp/payground-no-dashboard');
  });

  test('rejects an invalid drain timeout', async () => {
    const { env, err } = testEnv();
    expect(await main(['start', '--port', '0', '--drain-timeout', 'soon'], env)).toBe(2);
    expect(err[0]).toContain('--drain-timeout must be an integer');
  });

  test('rejects an invalid port', async () => {
    const { env, err } = testEnv();
    expect(await main(['start', '--port', '70000'], env)).toBe(2);
    expect(err[0]).toContain('--port must be an integer');
  });

  test('rate limiting is off by default and reported', async () => {
    const { env, out } = testEnv();
    expect(await main(['start', '--port', '0', '--db', ':memory:'], env)).toBe(0);
    expect(out.join('\n')).toContain('rate limit      off');
  });

  test('--rate-limit throttles a sandbox', async () => {
    const { env, out } = testEnv();
    const codes: number[] = [];
    env.waitForShutdown = async (url) => {
      const token = (out.find((line) => line.includes('access token')) ?? '').split(/\s+/).at(-1) as string;
      // The CLI runs on the system clock, so assert the shape rather than an exact sequence:
      // 10 calls against 1/s cannot all pass however slow the box is.
      for (let i = 0; i < 10; i++) {
        const response = await fetch(`${url}/v1/payments/search`, { headers: { authorization: `Bearer ${token}` } });
        codes.push(response.status);
        if (response.status === 429) expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      }
    };

    expect(await main(['start', '--port', '0', '--db', ':memory:', '--rate-limit', '1', '--rate-burst', '2'], env)).toBe(0);
    expect(codes[0]).toBe(200);
    expect(codes.filter((code) => code === 429).length).toBeGreaterThanOrEqual(6);
    expect(out.join('\n')).toContain('rate limit      1/s per sandbox, burst 2');
  });

  test('reads the rate limit from the environment', async () => {
    const { env, out } = testEnv({ variables: { PAYGROUND_RATE_LIMIT: '5', PAYGROUND_RATE_BURST: '9' } });
    expect(await main(['start', '--port', '0', '--db', ':memory:'], env)).toBe(0);
    expect(out.join('\n')).toContain('rate limit      5/s per sandbox, burst 9');
  });

  test('--no-rate-limit overrides the environment', async () => {
    const { env, out } = testEnv({ variables: { PAYGROUND_RATE_LIMIT: '5' } });
    expect(await main(['start', '--port', '0', '--db', ':memory:', '--no-rate-limit'], env)).toBe(0);
    expect(out.join('\n')).toContain('rate limit      off');
  });

  test('an empty environment variable leaves throttling off', async () => {
    const { env, out } = testEnv({ variables: { PAYGROUND_RATE_LIMIT: '', PAYGROUND_RATE_BURST: '' } });
    expect(await main(['start', '--port', '0', '--db', ':memory:'], env)).toBe(0);
    expect(out.join('\n')).toContain('rate limit      off');
  });

  test('rejects a bad rate limit', async () => {
    const { env, err } = testEnv();
    expect(await main(['start', '--port', '0', '--rate-limit', '0'], env)).toBe(2);
    expect(err[0]).toContain('--rate-limit must be an integer');

    const second = testEnv();
    expect(await main(['start', '--port', '0', '--rate-burst', '5'], second.env)).toBe(2);
    expect(second.err[0]).toContain('--rate-burst needs --rate-limit');
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
