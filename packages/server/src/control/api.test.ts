import { afterEach, describe, expect, test } from 'bun:test';
import { ManualClock, SeededIdGenerator } from '@payground/core/testing.ts';
import { Storage } from '@payground/storage';
import { createServer } from '../server.ts';

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

function start() {
  const clock = new ManualClock(1_700_000_000_000);
  const server = createServer({
    port: 0,
    clock,
    storage: Storage.open(),
    ids: new SeededIdGenerator(),
    deliveryIntervalMs: 0,
    bootstrap: { accessToken: 'TEST-a', publicKey: 'TEST-p', webhookSecret: 's' },
  });
  stop = async () => {
    await server.stop(true);
  };

  const origin = server.url.origin;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer TEST-a',
        'x-idempotency-key': crypto.randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };

  return { server, clock, call, api, sandbox: server.app.defaultSandbox as NonNullable<typeof server.app.defaultSandbox> };
}

const pix = {
  transaction_amount: 100,
  payment_method_id: 'pix',
  payer: { email: 'payer@example.com' },
};

describe('sandboxes', () => {
  test('lists the bootstrapped sandbox with its credentials', async () => {
    const app = start();
    const { status, body } = await app.call('GET', '/_payground/sandboxes');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ accessToken: 'TEST-a', publicKey: 'TEST-p', liveMode: false });
  });

  test('creates, resets and deletes', async () => {
    const app = start();
    const created = await app.call('POST', '/_payground/sandboxes', { name: 'second' });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('second');
    expect((await app.call('GET', '/_payground/sandboxes')).body).toHaveLength(2);

    expect((await app.call('POST', `/_payground/sandboxes/${created.body.id}/reset`)).status).toBe(200);
    expect((await app.call('DELETE', `/_payground/sandboxes/${created.body.id}`)).status).toBe(200);
    expect((await app.call('GET', '/_payground/sandboxes')).body).toHaveLength(1);
  });

  test('an unknown sandbox is a 404', async () => {
    const app = start();
    expect((await app.call('POST', '/_payground/sandboxes/ghost/reset')).status).toBe(404);
    expect((await app.call('GET', '/_payground/sandboxes/ghost/payments')).status).toBe(404);
  });
});

describe('payments through the control API', () => {
  test('lists what the emulated API created', async () => {
    const app = start();
    await app.api('POST', '/v1/payments', pix);
    const { body } = await app.call('GET', `/_payground/sandboxes/${app.sandbox.id}/payments`);

    expect(body.total).toBe(1);
    expect(body.results[0]).toMatchObject({
      state: 'pending',
      providerStatus: 'pending',
      providerStatusDetail: 'pending_waiting_transfer',
      methodCode: 'pix',
      amount: 10_000,
    });
  });

  test('approving a pending Pix moves it to approved on the emulated API too', async () => {
    const app = start();
    const created = await app.api('POST', '/v1/payments', pix);
    const list = await app.call('GET', `/_payground/sandboxes/${app.sandbox.id}/payments`);
    const internalId = list.body.results[0].id;

    const acted = await app.call(
      'POST',
      `/_payground/sandboxes/${app.sandbox.id}/payments/${internalId}/actions`,
      { type: 'settle' },
    );
    expect(acted.status).toBe(200);
    expect(acted.body.payment.state).toBe('succeeded');

    const read = await app.api('GET', `/v1/payments/${created.body.id}`);
    expect(read.body).toMatchObject({ status: 'approved', status_detail: 'accredited' });
  });

  test('an action the state forbids is a conflict', async () => {
    const app = start();
    await app.api('POST', '/v1/payments', pix);
    const list = await app.call('GET', `/_payground/sandboxes/${app.sandbox.id}/payments`);
    const id = list.body.results[0].id;

    expect((await app.call('POST', `/_payground/sandboxes/${app.sandbox.id}/payments/${id}/actions`, { type: 'capture', amount: null })).status).toBe(409);
    expect((await app.call('POST', `/_payground/sandboxes/${app.sandbox.id}/payments/${id}/actions`, { type: 'nonsense' })).status).toBe(400);
  });

  test('the detail view carries the timeline and refunds', async () => {
    const app = start();
    await app.api('POST', '/v1/payments', pix);
    const list = await app.call('GET', `/_payground/sandboxes/${app.sandbox.id}/payments`);
    const id = list.body.results[0].id;

    await app.call('POST', `/_payground/sandboxes/${app.sandbox.id}/payments/${id}/actions`, { type: 'settle' });
    const detail = await app.call('GET', `/_payground/sandboxes/${app.sandbox.id}/payments/${id}`);

    expect(detail.body.timeline).toHaveLength(1);
    expect(detail.body.timeline[0]).toMatchObject({ from: { state: 'pending' }, to: { state: 'succeeded' } });
    expect(detail.body.refunds).toEqual([]);
  });
});

describe('faults', () => {
  test('round trips and clamps out-of-range values', async () => {
    const app = start();
    expect((await app.call('GET', `/_payground/sandboxes/${app.sandbox.id}/faults`)).body).toEqual({
      latencyMs: 0,
      errorRate: 0,
      unavailable: false,
      duplicateWebhooks: false,
      webhookFailureRate: 0,
    });

    const updated = await app.call('PUT', `/_payground/sandboxes/${app.sandbox.id}/faults`, {
      latencyMs: -5,
      errorRate: 9,
      unavailable: true,
      webhookFailureRate: 0.25,
    });
    expect(updated.body).toEqual({
      latencyMs: 0,
      errorRate: 1,
      unavailable: true,
      duplicateWebhooks: false,
      webhookFailureRate: 0.25,
    });
    expect((await app.call('GET', `/_payground/sandboxes/${app.sandbox.id}/faults`)).body.errorRate).toBe(1);
  });
});

describe('webhooks', () => {
  test('a payment with a notification url queues a signed delivery that can be replayed', async () => {
    const app = start();
    const received: Record<string, string>[] = [];
    const receiver = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => {
        received.push(Object.fromEntries(request.headers.entries()));
        return new Response('ok');
      },
    });

    try {
      await app.api('POST', '/v1/payments', { ...pix, notification_url: `${receiver.url.origin}/hook` });

      const queued = await app.call('GET', `/_payground/sandboxes/${app.sandbox.id}/webhooks`);
      expect(queued.body).toHaveLength(1);
      expect(queued.body[0]).toMatchObject({ event: 'payment.created', status: 'queued', attempts: 0 });
      expect(queued.body[0].requestHeaders['x-signature']).toMatch(/^ts=\d+,v1=[0-9a-f]{64}$/);

      const replayed = await app.call(
        'POST',
        `/_payground/sandboxes/${app.sandbox.id}/webhooks/${queued.body[0].id}/replay`,
      );
      expect(replayed.status).toBe(200);
      expect(received).toHaveLength(1);

      const after = await app.call('GET', `/_payground/sandboxes/${app.sandbox.id}/webhooks`);
      expect(after.body[0]).toMatchObject({ status: 'delivered', attempts: 1, lastStatusCode: 200 });
      expect(after.body[0].history).toHaveLength(1);
    } finally {
      await receiver.stop(true);
    }
  });
});

describe('fault injection reaches the emulated API', () => {
  const setFaults = (app: ReturnType<typeof start>, profile: Record<string, unknown>) =>
    app.call('PUT', `/_payground/sandboxes/${app.sandbox.id}/faults`, profile);

  test('unavailable turns every emulated call into a 503', async () => {
    const app = start();
    await setFaults(app, { unavailable: true });
    const response = await app.api('POST', '/v1/payments', pix);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: 'service_unavailable', status: 503 });

    await setFaults(app, { unavailable: false });
    expect((await app.api('POST', '/v1/payments', pix)).status).toBe(201);
  });

  test('a full error rate makes every emulated call fail', async () => {
    const app = start();
    await setFaults(app, { errorRate: 1 });
    const response = await app.api('POST', '/v1/payments', pix);
    expect(response.status).toBe(500);
  });

  test('artificial latency delays the response', async () => {
    const app = start();
    await setFaults(app, { latencyMs: 120 });
    const before = Date.now();
    await app.api('GET', '/v1/payments/search');
    expect(Date.now() - before).toBeGreaterThanOrEqual(100);
  });

  test('the control API keeps working while the emulated API is down', async () => {
    const app = start();
    await setFaults(app, { unavailable: true });
    expect((await app.call('GET', '/_payground/sandboxes')).status).toBe(200);
  });
});

describe('admin token gating', () => {
  const guarded = () => {
    const clock = new ManualClock(1_700_000_000_000);
    const server = createServer({
      port: 0,
      clock,
      storage: Storage.open(),
      ids: new SeededIdGenerator(),
      deliveryIntervalMs: 0,
      adminToken: 'admin-secret',
      bootstrap: { accessToken: 'TEST-a', publicKey: 'TEST-p', webhookSecret: 's' },
    });
    stop = async () => {
      await server.stop(true);
    };
    return server;
  };

  const call = (origin: string, path: string, token?: string) =>
    fetch(`${origin}${path}`, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } });

  test('every control route refuses an unauthenticated caller', async () => {
    const server = guarded();
    const sandbox = server.app.defaultSandbox as NonNullable<typeof server.app.defaultSandbox>;
    const paths = [
      '/_payground/sandboxes',
      `/_payground/sandboxes/${sandbox.id}`,
      `/_payground/sandboxes/${sandbox.id}/payments`,
      `/_payground/sandboxes/${sandbox.id}/webhooks`,
      `/_payground/sandboxes/${sandbox.id}/faults`,
    ];
    for (const path of paths) {
      const response = await call(server.url.origin, path);
      expect([path, response.status]).toEqual([path, 401]);
      expect(((await response.json()) as { error: string }).error).toBe('unauthorized');
    }
  });

  test('credentials are never readable without the token', async () => {
    const server = guarded();
    const body = await (await call(server.url.origin, '/_payground/sandboxes')).text();
    expect(body).not.toContain('TEST-a');
    expect(body).not.toContain('TEST-p');
  });

  test('the right token unlocks the control API', async () => {
    const server = guarded();
    const response = await call(server.url.origin, '/_payground/sandboxes', 'admin-secret');
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown[]).toHaveLength(1);
  });

  test('a wrong token is refused on writes too', async () => {
    const server = guarded();
    const response = await fetch(`${server.url.origin}/_payground/sandboxes`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'intruder' }),
    });
    expect(response.status).toBe(401);
    await response.json();

    const listed = await call(server.url.origin, '/_payground/sandboxes', 'admin-secret');
    expect((await listed.json()) as unknown[]).toHaveLength(1);
  });

  test('health stays public so probes keep working', async () => {
    const server = guarded();
    expect((await call(server.url.origin, '/_payground/health')).status).toBe(200);
  });

  test('the emulated API is unaffected by the admin token', async () => {
    const server = guarded();
    const response = await fetch(`${server.url.origin}/v1/payments`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer TEST-a',
        'content-type': 'application/json',
        'x-idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify(pix),
    });
    expect(response.status).toBe(201);
    await response.json();
  });
});

describe('renaming a sandbox', () => {
  test('changes the name and reports it back', async () => {
    const app = start();
    const renamed = await app.call('PUT', `/_payground/sandboxes/${app.sandbox.id}`, { name: 'staging' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('staging');
    expect((await app.call('GET', '/_payground/sandboxes')).body[0].name).toBe('staging');
  });

  test('trims the name and refuses an empty or missing one', async () => {
    const app = start();
    expect((await app.call('PUT', `/_payground/sandboxes/${app.sandbox.id}`, { name: '  spaced  ' })).body.name).toBe('spaced');
    expect((await app.call('PUT', `/_payground/sandboxes/${app.sandbox.id}`, { name: '   ' })).status).toBe(400);
    expect((await app.call('PUT', `/_payground/sandboxes/${app.sandbox.id}`, {})).status).toBe(400);
    expect((await app.call('PUT', `/_payground/sandboxes/${app.sandbox.id}`, { name: 7 })).status).toBe(400);
  });

  test('leaves the credentials and the data untouched', async () => {
    const app = start();
    await app.api('POST', '/v1/payments', pix);
    await app.call('PUT', `/_payground/sandboxes/${app.sandbox.id}`, { name: 'renamed' });

    const detail = await app.call('GET', `/_payground/sandboxes/${app.sandbox.id}`);
    expect(detail.body.accessToken).toBe('TEST-a');
    expect(detail.body.counts.payments).toBe(1);
  });

  test('an unknown sandbox is a 404', async () => {
    const app = start();
    expect((await app.call('PUT', '/_payground/sandboxes/ghost', { name: 'x' })).status).toBe(404);
  });
});
