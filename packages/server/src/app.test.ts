import { afterEach, describe, expect, test } from 'bun:test';
import { ManualClock, SeededIdGenerator } from '@payground/core/testing.ts';
import { Storage } from '@payground/storage';
import { createServer } from './server.ts';

const TOKEN = 'TEST-access-token';
const PUBLIC = 'TEST-public-key';

interface Harness {
  url: string;
  clock: ManualClock;
  stop(): Promise<void>;
  call(method: string, path: string, init?: { body?: unknown; token?: string | null; key?: string | null }): Promise<{ status: number; body: any; headers: Headers }>;
}

const servers: Harness[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.stop();
});

function start(now = 1_700_000_000_000): Harness {
  const clock = new ManualClock(now);
  const server = createServer({
    port: 0,
    clock,
    storage: Storage.open(),
    ids: new SeededIdGenerator(),
    bootstrap: { accessToken: TOKEN, publicKey: PUBLIC, webhookSecret: 'shh' },
  });

  const harness: Harness = {
    url: server.url.origin,
    clock,
    stop: async () => {
      await server.stop(true);
    },
    async call(method, path, init = {}) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const token = init.token === undefined ? TOKEN : init.token;
      if (token !== null) headers['authorization'] = `Bearer ${token}`;
      const key = init.key === undefined ? crypto.randomUUID() : init.key;
      if (key !== null) headers['x-idempotency-key'] = key;

      const response = await fetch(`${server.url.origin}${path}`, {
        method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      return { status: response.status, body: await response.json(), headers: response.headers };
    },
  };
  servers.push(harness);
  return harness;
}

const pixBody = (overrides: Record<string, unknown> = {}) => ({
  transaction_amount: 100.5,
  payment_method_id: 'pix',
  description: 'Test purchase',
  payer: { email: 'payer@example.com', identification: { type: 'CPF', number: '12345678909' } },
  ...overrides,
});

describe('authentication', () => {
  test('rejects a missing, malformed or unknown token', async () => {
    const app = start();
    expect((await app.call('POST', '/v1/payments', { body: pixBody(), token: null })).status).toBe(401);
    expect((await app.call('POST', '/v1/payments', { body: pixBody(), token: 'garbage' })).status).toBe(401);
    expect((await app.call('POST', '/v1/payments', { body: pixBody(), token: 'TEST-nope' })).status).toBe(401);
  });

  test('reports the error in the provider envelope', async () => {
    const app = start();
    const { body } = await app.call('GET', '/v1/payments/1', { token: null });
    expect(body).toMatchObject({ error: 'unauthorized', status: 401 });
    expect(Array.isArray(body.cause)).toBe(true);
  });

  test('a public key is not an access token', async () => {
    const app = start();
    expect((await app.call('GET', '/v1/payments/1', { token: PUBLIC })).status).toBe(401);
  });
});

describe('idempotency', () => {
  test('is required on payment creation', async () => {
    const app = start();
    const { status, body } = await app.call('POST', '/v1/payments', { body: pixBody(), key: null });
    expect(status).toBe(400);
    expect(body.message).toContain('X-Idempotency-Key');
  });

  test('the same key replays the original response without creating a second payment', async () => {
    const app = start();
    const first = await app.call('POST', '/v1/payments', { body: pixBody(), key: 'k1' });
    const second = await app.call('POST', '/v1/payments', { body: pixBody(), key: 'k1' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers.get('x-idempotency-replayed')).toBe('true');

    const search = await app.call('GET', '/v1/payments/search');
    expect(search.body.paging.total).toBe(1);
  });

  test('the same key with a different body is a conflict', async () => {
    const app = start();
    await app.call('POST', '/v1/payments', { body: pixBody(), key: 'k1' });
    const clash = await app.call('POST', '/v1/payments', {
      body: pixBody({ transaction_amount: 7 }),
      key: 'k1',
    });
    expect(clash.status).toBe(409);
  });

  test('the key expires after 24 hours', async () => {
    const app = start();
    const first = await app.call('POST', '/v1/payments', { body: pixBody(), key: 'k1' });
    app.clock.advance(24 * 60 * 60 * 1000);
    const second = await app.call('POST', '/v1/payments', { body: pixBody(), key: 'k1' });
    expect(second.body.id).not.toBe(first.body.id);
  });
});

describe('pix payments', () => {
  test('creates a pending payment carrying a QR code', async () => {
    const app = start();
    const { status, body } = await app.call('POST', '/v1/payments', { body: pixBody() });

    expect(status).toBe(201);
    expect(body).toMatchObject({
      status: 'pending',
      status_detail: 'pending_waiting_transfer',
      payment_method_id: 'pix',
      payment_type_id: 'bank_transfer',
      currency_id: 'BRL',
      transaction_amount: 100.5,
      live_mode: false,
      captured: false,
    });
    expect(typeof body.id).toBe('number');
    expect(body.point_of_interaction.type).toBe('PIX');
    expect(body.point_of_interaction.transaction_data.qr_code).toStartWith('000201');
    expect(body.point_of_interaction.transaction_data.qr_code_base64.length).toBeGreaterThan(100);
    expect(body.point_of_interaction.transaction_data.ticket_url).toContain('/ticket');
    expect(body.date_of_expiration).not.toBeNull();
  });

  test('defaults the deadline to 24 hours and honours an explicit one', async () => {
    const app = start();
    const created = await app.call('POST', '/v1/payments', { body: pixBody() });
    expect(Date.parse(created.body.date_of_expiration) - app.clock.now()).toBe(24 * 60 * 60 * 1000);

    const custom = new Date(app.clock.now() + 45 * 60 * 1000).toISOString();
    const explicit = await app.call('POST', '/v1/payments', {
      body: pixBody({ date_of_expiration: custom }),
    });
    expect(Date.parse(explicit.body.date_of_expiration)).toBe(Date.parse(custom));
  });

  test('refuses a deadline outside the documented window', async () => {
    const app = start();
    for (const minutes of [29, 31 * 24 * 60]) {
      const at = new Date(app.clock.now() + minutes * 60 * 1000).toISOString();
      const response = await app.call('POST', '/v1/payments', { body: pixBody({ date_of_expiration: at }) });
      expect(response.status).toBe(400);
      expect(response.body.cause[0].description).toContain('30 minutes and 30 days');
    }
  });

  test('expires on read once the deadline passes', async () => {
    const app = start();
    const created = await app.call('POST', '/v1/payments', { body: pixBody() });

    app.clock.advance(24 * 60 * 60 * 1000);
    const read = await app.call('GET', `/v1/payments/${created.body.id}`);
    expect(read.body).toMatchObject({ status: 'cancelled', status_detail: 'expired' });
  });

  test('rejects an invalid body with the provider error shape', async () => {
    const app = start();
    const cases: [Record<string, unknown>, string][] = [
      [pixBody({ transaction_amount: -1 }), 'transaction_amount'],
      [pixBody({ transaction_amount: undefined }), 'transaction_amount'],
      [pixBody({ payment_method_id: 'unknown_method' }), 'payment_method_id'],
      [pixBody({ payer: { email: 'not-an-email' } }), 'payer.email'],
    ];
    for (const [body, hint] of cases) {
      const response = await app.call('POST', '/v1/payments', { body });
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body.cause)).toContain(hint);
    }
  });

  test('a body that is not JSON is refused', async () => {
    const app = start();
    const response = await fetch(`${app.url}/v1/payments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-idempotency-key': 'k', 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as any).cause[0].code).toBe(118);
  });
});

describe('lifecycle', () => {
  test('cancel moves a pending payment to cancelled by the collector', async () => {
    const app = start();
    const created = await app.call('POST', '/v1/payments', { body: pixBody() });
    const cancelled = await app.call('PUT', `/v1/payments/${created.body.id}`, { body: { status: 'cancelled' } });
    expect(cancelled.body).toMatchObject({ status: 'cancelled', status_detail: 'by_collector' });

    const again = await app.call('PUT', `/v1/payments/${created.body.id}`, { body: { status: 'cancelled' } });
    expect(again.status).toBe(422);
  });

  test('an unknown payment is a 404 in the provider envelope', async () => {
    const app = start();
    const missing = await app.call('GET', '/v1/payments/999999');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: 'not_found', status: 404 });
  });
});

describe('search', () => {
  test('pages, filters and reports the total', async () => {
    const app = start();
    for (let i = 0; i < 5; i++) {
      await app.call('POST', '/v1/payments', { body: pixBody({ external_reference: i < 2 ? 'A' : 'B' }) });
      app.clock.advance(1_000);
    }

    const all = await app.call('GET', '/v1/payments/search');
    expect(all.body.paging).toMatchObject({ total: 5, offset: 0 });

    const filtered = await app.call('GET', '/v1/payments/search?external_reference=A');
    expect(filtered.body.paging.total).toBe(2);

    const paged = await app.call('GET', '/v1/payments/search?limit=2&offset=1');
    expect(paged.body.results).toHaveLength(2);
    expect(paged.body.paging).toMatchObject({ total: 5, limit: 2, offset: 1 });

    const byStatus = await app.call('GET', '/v1/payments/search?status=pending');
    expect(byStatus.body.paging.total).toBe(5);
    expect((await app.call('GET', '/v1/payments/search?status=approved')).body.paging.total).toBe(0);
  });

  test('search results report the id as a string, as the real API does', async () => {
    const app = start();
    await app.call('POST', '/v1/payments', { body: pixBody() });
    const page = await app.call('GET', '/v1/payments/search');
    expect(typeof page.body.results[0].id).toBe('string');
  });
});
