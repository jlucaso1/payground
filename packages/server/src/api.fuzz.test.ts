import { afterEach, describe, expect, test } from 'bun:test';
import { ManualClock, SeededIdGenerator, SeededRandom } from '@payground/core/testing.ts';
import { Storage } from '@payground/storage';
import { createServer } from './server.ts';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

function start() {
  const server = createServer({
    port: 0,
    clock: new ManualClock(1_700_000_000_000),
    storage: Storage.open(),
    ids: new SeededIdGenerator(),
    deliveryIntervalMs: 0,
    bootstrap: { accessToken: 'TEST-a', publicKey: 'TEST-p', webhookSecret: 's' },
  });
  close = async () => {
    await server.stop(true);
  };
  return server;
}

const HOSTILE: unknown[] = [
  null,
  0,
  '',
  'string',
  [],
  [1, 2, 3],
  { transaction_amount: '100' },
  { transaction_amount: Number.NaN },
  { transaction_amount: Number.POSITIVE_INFINITY },
  { transaction_amount: -0 },
  { transaction_amount: 1e308 },
  { transaction_amount: 100, payment_method_id: 'pix' },
  { transaction_amount: 100, payment_method_id: 'pix', payer: null },
  { transaction_amount: 100, payment_method_id: 'pix', payer: { email: '' } },
  { transaction_amount: 100, payment_method_id: 1, payer: { email: 'a@b.c' } },
  { transaction_amount: 100, payment_method_id: 'pix', payer: { email: 'a@b.c' }, metadata: 'not-an-object' },
  { transaction_amount: 100, payment_method_id: 'pix', payer: { email: 'a@b.c' }, installments: -1 },
  { transaction_amount: 100, payment_method_id: 'pix', payer: { email: 'a@b.c' }, date_of_expiration: 'nope' },
  { transaction_amount: 100, payment_method_id: "'; drop table payments; --", payer: { email: 'a@b.c' } },
];

/** Odd but legal: these must be accepted, not rejected. */
const AWKWARD: unknown[] = [
  { transaction_amount: 100, payment_method_id: 'pix', payer: { email: 'a@b.c' }, description: ' \uFFFF\u202E' },
  { transaction_amount: 0.01, payment_method_id: 'pix', payer: { email: 'a@b.c' } },
  { transaction_amount: 100, payment_method_id: 'pix', payer: { email: 'a@b.c' }, metadata: {} },
  { transaction_amount: 100, payment_method_id: 'pix', payer: { email: 'a@b.c' }, external_reference: '' },
  { transaction_amount: 100, payment_method_id: 'pix', payer: { email: 'a@b.c' }, unknown_field: 'ignored' },
];

function randomJson(rng: SeededRandom, depth = 0): unknown {
  switch (rng.int(depth > 2 ? 6 : 8)) {
    case 0:
      return null;
    case 1:
      return rng.int(1_000_000) - 500_000;
    case 2:
      return rng.int(2) === 0;
    case 3:
      return String.fromCharCode(...Array.from({ length: rng.int(12) }, () => 32 + rng.int(200)));
    case 4:
      return (rng.int(1_000_000) - 500_000) / 7;
    case 5:
      return {};
    case 6:
      return Array.from({ length: rng.int(4) }, () => randomJson(rng, depth + 1));
    default: {
      const out: Record<string, unknown> = {};
      const keys = ['transaction_amount', 'payment_method_id', 'payer', 'metadata', 'installments', 'token', 'x'];
      for (let i = 0; i < rng.int(5); i++) {
        out[keys[rng.int(keys.length)] as string] = randomJson(rng, depth + 1);
      }
      return out;
    }
  }
}

describe('the API never fails open', () => {
  const post = (origin: string, path: string, body: string) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer TEST-a',
        'x-idempotency-key': crypto.randomUUID(),
      },
      body,
    });

  test('hostile payment bodies are rejected, never accepted and never a 500', async () => {
    const server = start();
    for (const body of HOSTILE) {
      const response = await post(server.url.origin, '/v1/payments', JSON.stringify(body));
      expect([body, response.status < 500]).toEqual([body, true]);
      expect([body, response.status]).not.toEqual([body, 201]);
      const parsed = (await response.json()) as { status?: number; error?: string };
      expect(parsed.status).toBe(response.status);
      expect(typeof parsed.error).toBe('string');
    }
  });

  test('odd but legal bodies are accepted', async () => {
    const server = start();
    for (const body of AWKWARD) {
      const response = await post(server.url.origin, '/v1/payments', JSON.stringify(body));
      expect([body, response.status]).toEqual([body, 201]);
      await response.json();
    }
  });

  test('random JSON bodies never produce a server error', async () => {
    const server = start();
    const rng = new SeededRandom(31);
    for (let i = 0; i < 400; i++) {
      const body = JSON.stringify(randomJson(rng));
      const response = await post(server.url.origin, '/v1/payments', body);
      expect([body, response.status < 500]).toEqual([body, true]);
      await response.json();
    }
  });

  test('malformed transport is rejected cleanly', async () => {
    const server = start();
    for (const raw of ['', '{', 'null', '[', 'undefined', '{"a":', ' ']) {
      const response = await post(server.url.origin, '/v1/payments', raw);
      expect(response.status).toBeLessThan(500);
      await response.json();
    }
  });

  test('paths and query strings cannot escape the sandbox', async () => {
    const server = start();
    const paths = [
      '/v1/payments/../../etc/passwd',
      '/v1/payments/%2e%2e%2f',
      '/v1/payments/NaN',
      '/v1/payments/-1',
      '/v1/payments/1e999',
      '/v1/payments/search?limit=-1',
      '/v1/payments/search?limit=999999999',
      '/v1/payments/search?offset=-5',
      "/v1/payments/search?external_reference=' or 1=1--",
      `/v1/payments/search?status=${encodeURIComponent('approved,nonsense')}`,
    ];
    for (const path of paths) {
      const response = await fetch(`${server.url.origin}${path}`, {
        headers: { authorization: 'Bearer TEST-a' },
      });
      expect([path, response.status < 500]).toEqual([path, true]);
      await response.text();
    }
  });

  test('every emulated route refuses an unauthenticated caller', async () => {
    const server = start();
    const routes: [string, string][] = [
      ['POST', '/v1/payments'],
      ['GET', '/v1/payments/1'],
      ['PUT', '/v1/payments/1'],
      ['GET', '/v1/payments/search'],
      ['POST', '/v1/payments/1/refunds'],
      ['GET', '/v1/payments/1/refunds'],
      ['POST', '/v1/card_tokens'],
      ['GET', '/v1/payment_methods'],
    ];
    for (const [method, path] of routes) {
      const response = await fetch(`${server.url.origin}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-idempotency-key': 'k' },
        ...(method === 'GET' ? {} : { body: '{}' }),
      });
      expect([method, path, response.status]).toEqual([method, path, 401]);
    }
  });

  test('one sandbox can never read another', async () => {
    const server = start();
    const second = (await (
      await fetch(`${server.url.origin}/_payground/sandboxes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'other' }),
      })
    ).json()) as { accessToken: string };

    const created = (await (
      await post(
        server.url.origin,
        '/v1/payments',
        JSON.stringify({ transaction_amount: 10, payment_method_id: 'pix', payer: { email: 'a@b.c' } }),
      )
    ).json()) as { id: number };

    const foreign = await fetch(`${server.url.origin}/v1/payments/${created.id}`, {
      headers: { authorization: `Bearer ${second.accessToken}` },
    });
    expect(foreign.status).toBe(404);

    const search = await fetch(`${server.url.origin}/v1/payments/search`, {
      headers: { authorization: `Bearer ${second.accessToken}` },
    });
    expect(((await search.json()) as { paging: { total: number } }).paging.total).toBe(0);
  });
});
