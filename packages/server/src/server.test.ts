import { describe, expect, test } from 'bun:test';
import { ManualClock } from '@payground/core/testing.ts';
import { Storage } from '@payground/storage';
import { createServer } from './server.ts';

// Read from disk rather than importing, so a version bump in the manifest alone is
// enough to fail this test if the served version stops tracking it.
const packageVersion = (await Bun.file(`${import.meta.dir}/../../cli/package.json`).json()).version as string;

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
  test('health reports the package version and uptime from the injected clock', async () => {
    await withServer(async (url, clock) => {
      clock.advance(2_500);
      const res = await fetch(`${url}/_payground/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', version: packageVersion, uptime_ms: 2_500 });
    });
  });

  test('a drain lets an in-flight request finish before the socket closes', async () => {
    const storage = Storage.open();
    const server = createServer({ port: 0, clock: new ManualClock(1_000), storage, deliveryIntervalMs: 0 });
    const sandbox = server.app.defaultSandbox as NonNullable<typeof server.app.defaultSandbox>;
    // Injected latency is the only way to keep a request in flight for a measurable while.
    storage.forSandbox(sandbox.id).faults.set({
      latencyMs: 600,
      errorRate: 0,
      unavailable: false,
      duplicateWebhooks: false,
      webhookFailureRate: 0,
    });

    const inflight = fetch(`${server.url.origin}/v1/payments/search`, {
      headers: { authorization: `Bearer ${sandbox.accessToken}` },
    });
    await Bun.sleep(50);

    expect(await server.drain(5_000)).toBe('drained');
    expect((await inflight).status).toBe(200);
    await expect(fetch(`${server.url.origin}/_payground/health`)).rejects.toThrow();
    storage.close();
  });

  test('a drain that runs out of time cuts the remaining connections', async () => {
    const storage = Storage.open();
    const server = createServer({ port: 0, clock: new ManualClock(1_000), storage, deliveryIntervalMs: 0 });
    const sandbox = server.app.defaultSandbox as NonNullable<typeof server.app.defaultSandbox>;
    storage.forSandbox(sandbox.id).faults.set({
      latencyMs: 2_000,
      errorRate: 0,
      unavailable: false,
      duplicateWebhooks: false,
      webhookFailureRate: 0,
    });

    const inflight = fetch(`${server.url.origin}/v1/payments/search`, {
      headers: { authorization: `Bearer ${sandbox.accessToken}` },
    }).then(
      () => 'answered',
      () => 'cut',
    );
    await Bun.sleep(50);

    expect(await server.drain(200)).toBe('timeout');
    expect(await inflight).toBe('cut');
    storage.close();
  });

  test('unknown routes return the provider error envelope', async () => {
    await withServer(async (url) => {
      const res = await fetch(`${url}/v1/nope`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: 'not found', error: 'not_found', status: 404 });
    });
  });
});
