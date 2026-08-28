import { describe, expect, test } from 'bun:test';
import { ManualClock } from '@payground/core/testing.ts';
import { createServer } from './server.ts';

async function withServer<T>(fn: (url: string, clock: ManualClock) => Promise<T>): Promise<T> {
  const clock = new ManualClock(1_000);
  const server = createServer({ port: 0, clock });
  try {
    return await fn(server.url.origin, clock);
  } finally {
    await server.stop(true);
  }
}

describe('server', () => {
  test('health reports version and uptime from the injected clock', async () => {
    await withServer(async (url, clock) => {
      clock.advance(2_500);
      const res = await fetch(`${url}/_payground/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', version: '0.1.0', uptime_ms: 2_500 });
    });
  });

  test('unknown routes return the provider error envelope', async () => {
    await withServer(async (url) => {
      const res = await fetch(`${url}/v1/nope`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: 'not found', error: 'not_found', status: 404 });
    });
  });
});
