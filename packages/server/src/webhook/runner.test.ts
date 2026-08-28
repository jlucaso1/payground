import { afterEach, describe, expect, test } from 'bun:test';
import { type Sandbox, type WebhookDelivery, sandboxId } from '@payground/core';
import { ManualClock, SeededIdGenerator, SeededRandom } from '@payground/core/testing.ts';
import { Storage } from '@payground/storage';
import { enqueue } from './enqueue.ts';
import { DEFAULT_RETRY_POLICY, nextAttemptAt } from './policy.ts';
import { attempt, drain } from './runner.ts';

const sandbox: Sandbox = {
  id: sandboxId('s1'),
  name: 's1',
  accessToken: 'TEST-a',
  publicKey: 'TEST-p',
  webhookSecret: 'secret',
  liveMode: false,
  createdAt: 0,
};

const open = () => {
  const storage = Storage.open();
  storage.sandboxes.create(sandbox);
  return storage;
};

let servers: { stop(): void }[] = [];
afterEach(() => {
  for (const s of servers) s.stop();
  servers = [];
});

function receiver(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler });
  servers.push({ stop: () => void server.stop(true) });
  return server.url.origin;
}

const deps = (clock: ManualClock) => ({
  clock,
  random: new SeededRandom(1),
  net: { allowPrivateAddresses: true },
});

describe('retry policy', () => {
  test('backs off exponentially and stops at the attempt limit', () => {
    const now = 1_000;
    expect(nextAttemptAt(1, now)).toBe(now + 30_000);
    expect(nextAttemptAt(2, now)).toBe(now + 60_000);
    expect(nextAttemptAt(3, now)).toBe(now + 120_000);
    expect(nextAttemptAt(DEFAULT_RETRY_POLICY.maxAttempts, now)).toBeNull();
  });

  test('never exceeds the documented fifteen minute cadence', () => {
    for (let attempts = 1; attempts < DEFAULT_RETRY_POLICY.maxAttempts; attempts++) {
      const at = nextAttemptAt(attempts, 0);
      expect(at).not.toBeNull();
      expect(at as number).toBeLessThanOrEqual(15 * 60_000);
    }
  });
});

describe('enqueue', () => {
  test('does nothing without a notification url', () => {
    const storage = open();
    const store = storage.forSandbox(sandbox.id);
    const delivery = enqueue({
      store,
      sandbox,
      ids: new SeededIdGenerator(),
      notice: { type: 'payment', action: 'payment.created', dataId: '1', notificationUrl: null },
      now: 1_000,
      collectorId: 7,
    });
    expect(delivery).toBeNull();
    expect(store.webhooks.list()).toEqual([]);
    storage.close();
  });

  test('builds a signed, queued delivery', () => {
    const storage = open();
    const store = storage.forSandbox(sandbox.id);
    const delivery = enqueue({
      store,
      sandbox,
      ids: new SeededIdGenerator(),
      notice: { type: 'payment', action: 'payment.created', dataId: '42', notificationUrl: 'https://example.com/hook' },
      now: 1_700_000_000_000,
      collectorId: 7,
    }) as WebhookDelivery;

    expect(delivery.status).toBe('queued');
    expect(delivery.attempts).toBe(0);
    expect(delivery.requestHeaders['x-signature']).toMatch(/^ts=\d+,v1=[0-9a-f]{64}$/);
    expect(delivery.requestHeaders['x-request-id']).toBeString();
    expect(JSON.parse(delivery.requestBody)).toMatchObject({
      type: 'payment',
      action: 'payment.created',
      data: { id: '42' },
      user_id: 7,
      live_mode: false,
    });
    storage.close();
  });
});

describe('delivery', () => {
  const queue = (storage: Storage, url: string, now: number) =>
    enqueue({
      store: storage.forSandbox(sandbox.id),
      sandbox,
      ids: new SeededIdGenerator(),
      notice: { type: 'payment', action: 'payment.updated', dataId: '1', notificationUrl: url },
      now,
      collectorId: 7,
    }) as WebhookDelivery;

  test('a 200 marks the delivery delivered and records the attempt', async () => {
    const storage = open();
    const store = storage.forSandbox(sandbox.id);
    const clock = new ManualClock(1_000);
    const seen: Record<string, string>[] = [];
    const url = receiver((request) => {
      seen.push(Object.fromEntries(request.headers.entries()));
      return new Response('ok');
    });

    const delivery = queue(storage, url, clock.now());
    const result = await attempt(delivery, { store, ...deps(clock) });

    expect(result.delivery.status).toBe('delivered');
    expect(result.delivery.attempts).toBe(1);
    expect(result.delivery.nextAttemptAt).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.['x-signature']).toBe(delivery.requestHeaders['x-signature'] as string);
    expect(seen[0]?.['user-agent']).toContain('MercadoPago');
    expect(store.webhooks.attempts(delivery.id)).toHaveLength(1);
    storage.close();
  });

  test('a 500 schedules a retry and eventually exhausts', async () => {
    const storage = open();
    const store = storage.forSandbox(sandbox.id);
    const clock = new ManualClock(1_000);
    const url = receiver(() => new Response('nope', { status: 500 }));

    let delivery = queue(storage, url, clock.now());
    for (let i = 1; i < DEFAULT_RETRY_POLICY.maxAttempts; i++) {
      delivery = (await attempt(delivery, { store, ...deps(clock) })).delivery;
      expect(delivery.status).toBe('retrying');
      expect(delivery.nextAttemptAt).toBeGreaterThan(clock.now());
      clock.set(delivery.nextAttemptAt as number);
    }
    delivery = (await attempt(delivery, { store, ...deps(clock) })).delivery;
    expect(delivery.status).toBe('exhausted');
    expect(delivery.lastStatusCode).toBe(500);
    expect(store.webhooks.attempts(delivery.id)).toHaveLength(DEFAULT_RETRY_POLICY.maxAttempts);
    storage.close();
  });

  test('a 201 also counts as acknowledged, anything else does not', async () => {
    for (const [status, expected] of [[201, 'delivered'], [204, 'retrying'], [302, 'retrying'], [404, 'retrying']] as const) {
      const storage = open();
      const store = storage.forSandbox(sandbox.id);
      const clock = new ManualClock(1_000);
      const url = receiver(() => new Response(null, { status }));
      const result = await attempt(queue(storage, url, clock.now()), { store, ...deps(clock) });
      expect(result.delivery.status).toBe(expected);
      storage.close();
    }
  });

  test('an unreachable host is a typed error, not a throw', async () => {
    const storage = open();
    const store = storage.forSandbox(sandbox.id);
    const clock = new ManualClock(1_000);
    const result = await attempt(queue(storage, 'http://127.0.0.1:1/hook', clock.now()), {
      store,
      ...deps(clock),
    });
    expect(result.delivery.status).toBe('retrying');
    expect(result.delivery.lastError).toBeString();
    storage.close();
  });

  test('a private address is refused unless the self-host escape hatch is set', async () => {
    const storage = open();
    const store = storage.forSandbox(sandbox.id);
    const clock = new ManualClock(1_000);
    const url = receiver(() => new Response('ok'));

    const blocked = await attempt(queue(storage, url, clock.now()), {
      store,
      clock,
      random: new SeededRandom(1),
    });
    expect(blocked.delivery.status).toBe('retrying');
    expect(blocked.delivery.lastError).toContain('blocked_address');
    storage.close();
  });

  test('the injected failure rate makes every attempt fail', async () => {
    const storage = open();
    const store = storage.forSandbox(sandbox.id);
    store.faults.set({
      latencyMs: 0,
      errorRate: 0,
      unavailable: false,
      duplicateWebhooks: false,
      webhookFailureRate: 1,
    });
    const clock = new ManualClock(1_000);
    let hits = 0;
    const url = receiver(() => {
      hits += 1;
      return new Response('ok');
    });

    const result = await attempt(queue(storage, url, clock.now()), { store, ...deps(clock) });
    expect(result.delivery.status).toBe('retrying');
    expect(result.delivery.lastError).toContain('injected');
    expect(hits).toBe(0);
    storage.close();
  });

  test('duplicate delivery injection sends the notification twice', async () => {
    const storage = open();
    const store = storage.forSandbox(sandbox.id);
    store.faults.set({
      latencyMs: 0,
      errorRate: 0,
      unavailable: false,
      duplicateWebhooks: true,
      webhookFailureRate: 0,
    });
    const clock = new ManualClock(1_000);
    let hits = 0;
    const url = receiver(() => {
      hits += 1;
      return new Response('ok');
    });

    queue(storage, url, clock.now());
    await drain(storage.queue, () => store, { store, ...deps(clock) });
    expect(hits).toBe(2);
    storage.close();
  });
});

describe('queue draining', () => {
  test('only picks up deliveries that are due', async () => {
    const storage = open();
    const store = storage.forSandbox(sandbox.id);
    const clock = new ManualClock(1_000);
    const url = receiver(() => new Response('ok'));

    enqueue({
      store,
      sandbox,
      ids: new SeededIdGenerator(),
      notice: { type: 'payment', action: 'payment.created', dataId: '1', notificationUrl: url },
      now: clock.now(),
      collectorId: 7,
    });

    expect(await drain(storage.queue, () => store, { store, ...deps(clock) })).toBe(1);
    expect(await drain(storage.queue, () => store, { store, ...deps(clock) })).toBe(0);
    expect(store.webhooks.list()[0]?.status).toBe('delivered');
    storage.close();
  });
});
