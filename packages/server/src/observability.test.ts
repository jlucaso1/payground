import { afterEach, describe, expect, test } from 'bun:test';
import { ManualClock, SeededIdGenerator } from '@payground/core/testing.ts';
import { Storage } from '@payground/storage';
import { MetricsRegistry } from './metrics/index.ts';
import { createServer } from './server.ts';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

function start(options: { historyBodyLimit?: number } = {}) {
  const clock = new ManualClock(1_700_000_000_000);
  const metrics = new MetricsRegistry();
  const storage = Storage.open();
  const server = createServer({
    port: 0,
    clock,
    storage,
    metrics,
    ids: new SeededIdGenerator(),
    deliveryIntervalMs: 0,
    bootstrap: { accessToken: 'TEST-a', publicKey: 'TEST-p', webhookSecret: 's' },
    ...options,
  });
  close = async () => {
    await server.stop(true);
  };

  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${server.url.origin}${path}`, {
      method,
      headers: {
        authorization: 'Bearer TEST-a',
        'content-type': 'application/json',
        'x-idempotency-key': crypto.randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  return { server, clock, metrics, storage, api };
}

const pix = { transaction_amount: 100, payment_method_id: 'pix', payer: { email: 'a@b.c' } };

describe('metrics', () => {
  test('counts requests and records latency per route, method and status', async () => {
    const app = start();
    await (await app.api('POST', '/v1/payments', pix)).json();
    await (await app.api('GET', '/v1/payments/search')).json();
    await (await app.api('GET', '/v1/payments/999999')).json();

    const counters = app.metrics.counterSamples();
    const created = counters.find((c) => c.labels['route'] === '/v1/payments' && c.labels['method'] === 'POST');
    expect(created).toMatchObject({ name: 'payground_api_requests_total', value: 1 });
    expect(created?.labels['status']).toBe('201');

    const missing = counters.find((c) => c.labels['status'] === '404');
    expect(missing?.labels['route']).toBe('/v1/payments/:id');

    const durations = app.metrics.histogramSamples();
    expect(durations.length).toBeGreaterThan(0);
    expect(durations.every((d) => d.name === 'payground_api_request_duration_ms')).toBe(true);
    expect(durations.reduce((total, d) => total + d.count, 0)).toBe(3);
  });

  test('identifiers never leak into the route label', async () => {
    const app = start();
    const created = (await (await app.api('POST', '/v1/payments', pix)).json()) as { id: number };
    await (await app.api('GET', `/v1/payments/${created.id}`)).json();

    const routes = app.metrics.counterSamples().map((c) => c.labels['route']);
    expect(routes).toContain('/v1/payments/:id');
    expect(routes.join(' ')).not.toContain(String(created.id));
  });

  test('an unauthenticated call is still counted, as anonymous', async () => {
    const app = start();
    await fetch(`${app.server.url.origin}/v1/payments/search`);

    const sample = app.metrics.counterSamples().find((c) => c.labels['status'] === '401');
    expect(sample?.labels['sandbox']).toBe('anonymous');
  });
});

describe('request history', () => {
  test('records every call with its outcome and latency', async () => {
    const app = start();
    const created = (await (await app.api('POST', '/v1/payments', pix)).json()) as { id: number };
    await (await app.api('GET', '/v1/payments/999999')).json();

    const page = app.storage.requests.search({});
    expect(page.total).toBe(2);

    const failure = page.results.find((entry) => entry.status === 404);
    expect(failure).toMatchObject({ method: 'GET', route: '/v1/payments/:id', status: 404 });
    expect(failure?.path).toBe('/v1/payments/999999');

    const success = page.results.find((entry) => entry.status === 201);
    expect(success?.sandbox).not.toBeNull();
    expect(success?.idempotencyKey).toBeString();
    expect(success?.responseBody).toContain(String(created.id));
    expect(success?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('bodies over the limit are dropped instead of bloating the database', async () => {
    const app = start({ historyBodyLimit: 10 });
    await (await app.api('POST', '/v1/payments', pix)).json();
    expect(app.storage.requests.search({}).results[0]?.responseBody).toBeNull();
  });

  test('history can be turned off entirely', async () => {
    const app = start({ historyBodyLimit: 0 });
    await (await app.api('POST', '/v1/payments', pix)).json();
    const entry = app.storage.requests.search({}).results[0];
    expect(entry?.status).toBe(201);
    expect(entry?.responseBody).toBeNull();
  });

  test('the response the caller receives is untouched by the recording', async () => {
    const app = start();
    const response = await app.api('POST', '/v1/payments', pix);
    const body = (await response.json()) as { status: string };
    expect(response.status).toBe(201);
    expect(body.status).toBe('pending');
  });
});

describe('rate limiting', () => {
  test('a limiter that refuses produces a 429 with Retry-After', async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const server = createServer({
      port: 0,
      clock,
      storage: Storage.open(),
      ids: new SeededIdGenerator(),
      deliveryIntervalMs: 0,
      rateLimiter: { take: () => ({ allowed: false, remaining: 0, retryAfterMs: 1_500 }) },
      bootstrap: { accessToken: 'TEST-a', publicKey: 'TEST-p', webhookSecret: 's' },
    });
    close = async () => {
      await server.stop(true);
    };

    const response = await fetch(`${server.url.origin}/v1/payments/search`, {
      headers: { authorization: 'Bearer TEST-a' },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('2');
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'too_many_requests' });
  });

  test('the default limiter allows everything', async () => {
    const app = start();
    for (let i = 0; i < 5; i++) expect((await app.api('GET', '/v1/payments/search')).status).toBe(200);
  });
});
