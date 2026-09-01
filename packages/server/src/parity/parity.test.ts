import { afterEach, describe, expect, test } from 'bun:test';
import type { ApiRequestEntry, SandboxId } from '@payground/core';
import { ROUTES } from '@payground/mercadopago/generated/routes.ts';
import { TEST_ACCESS_TOKEN, type TestServer, startTestServer } from '../testing.ts';
import type { RouteModule } from '../routes/module.ts';
import { buildReport, readHistory } from './report.ts';
import { operationFor, responseSchema, routeKey } from './spec.ts';
import { validateNamed } from './validate.ts';

let app: TestServer | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

const pix = { transaction_amount: 100, payment_method_id: 'pix', payer: { email: 'a@b.c' } };

const entry = (overrides: Partial<ApiRequestEntry>): ApiRequestEntry => ({
  id: crypto.randomUUID(),
  at: 1_700_000_000_000,
  sandbox: null,
  method: 'GET',
  route: '/v1/payments/search',
  path: '/v1/payments/search',
  status: 200,
  durationMs: 1,
  requestBody: null,
  responseBody: null,
  idempotencyKey: null,
  userAgent: null,
  ...overrides,
});

describe('route matching', () => {
  test('every spec operation folds onto a distinct history label', () => {
    const keys = new Map<string, string[]>();
    for (const route of ROUTES) {
      const key = routeKey(route.method, route.pattern);
      keys.set(key, [...(keys.get(key) ?? []), route.operationId]);
    }
    expect([...keys].filter(([, ids]) => ids.length > 1)).toEqual([]);
    expect(keys.size).toBe(ROUTES.length);
  });

  test('a concrete path resolves to its operation', () => {
    expect(operationFor('POST', '/v1/payments')?.operationId).toBe('createPayment');
    expect(operationFor('GET', '/v1/payments/1234567890')?.operationId).toBe('getPayment');
    expect(operationFor('GET', '/v1/payments/search')?.operationId).toBe('searchPayments');
    // The official SDK posts to the trailing-slash alias.
    expect(operationFor('POST', '/checkout/preferences/')?.operationId).toBe('createPreference');
    expect(operationFor('GET', '/nowhere')).toBeUndefined();
  });

  test('response schemas come from the documented statuses', () => {
    expect(responseSchema('createPayment', 201)).toBeDefined();
    expect(responseSchema('createPayment', 418)).toBeUndefined();
  });
});

describe('body validation', () => {
  test('accepts a documented body', () => {
    expect(validateNamed('PaymentRequest', pix)).toEqual([]);
  });

  test('refuses an undocumented field', () => {
    expect(validateNamed('PaymentRequest', { ...pix, not_a_real_field: 1 })).toEqual([
      { path: 'not_a_real_field', message: 'not documented by the specification' },
    ]);
  });

  test('refuses a missing required field, a wrong type and a value outside an enum', () => {
    const issues = validateNamed('PaymentRequest', { payer: { email: 1 }, three_ds_mode: 'sometimes' });
    expect(issues.map((issue) => issue.path).sort()).toEqual(['payer.email', 'three_ds_mode', 'transaction_amount']);
  });

  test('a free-form object accepts anything', () => {
    expect(validateNamed('PaymentRequest', { ...pix, metadata: { whatever: [1, 2] } })).toEqual([]);
  });

  test('an undocumented field nested in a documented one is still caught', () => {
    expect(validateNamed('PaymentRequest', { ...pix, payer: { email: 'a@b.c', nope: true } })).toEqual([
      { path: 'payer.nope', message: 'not documented by the specification' },
    ]);
  });
});

describe('report', () => {
  test('reads the whole history past one page', () => {
    app = startTestServer();
    for (let index = 0; index < 3; index += 1) {
      app.storage.requests.record(entry({ at: 1_700_000_000_000 + index }));
    }
    const history = readHistory(app.storage.requests, null, Number.MAX_SAFE_INTEGER);
    expect(history).toHaveLength(3);
    expect(history[0]?.at).toBe(1_700_000_000_000);
  });

  test('groups the calls by operation and flags the bodies the real API would reject', async () => {
    app = startTestServer();
    expect((await app.api('POST', '/v1/payments', { body: { ...pix, not_a_real_field: 1 } })).status).toBe(201);
    expect((await app.api('POST', '/v1/payments', { body: pix })).status).toBe(201);
    await app.api('GET', '/v1/payments/search');

    const report = buildReport({ entries: readHistory(app.storage.requests, null, Number.MAX_SAFE_INTEGER), now: 1 });
    expect(report.requests).toBe(3);
    expect(report.operations).toMatchObject([
      { operationId: 'createPayment', module: 'payments', state: 'emulated', calls: 2 },
      { operationId: 'searchPayments', module: 'payments', state: 'emulated', calls: 1 },
    ]);
    expect(report.rejected).toMatchObject([
      { operationId: 'createPayment', calls: 1, issues: [{ path: 'not_a_real_field' }] },
    ]);
    expect(report.verdict.blocking).toBe(true);
    expect(report.verdict.findings[0]).toContain('not_a_real_field');
  });

  test('a clean history has no blocking finding', async () => {
    app = startTestServer();
    await app.api('POST', '/v1/payments', { body: pix });
    const report = buildReport({ entries: readHistory(app.storage.requests, null, Number.MAX_SAFE_INTEGER), now: 1 });
    expect(report.verdict).toEqual({ blocking: false, findings: [] });
  });

  test('an operation the registry lists as pending is blocking', () => {
    // Injected rather than borrowed from the real registry, which aims to have nothing pending.
    const stub: RouteModule = {
      name: 'checkout',
      operations: [],
      pending: [{ operationId: 'createMerchantOrder', reason: 'merchant orders are derived from preferences' }],
      routes: () => ({}),
    };

    const report = buildReport({
      entries: [entry({ method: 'POST', route: '/merchant_orders', path: '/merchant_orders', status: 201 })],
      now: 1,
      modules: [stub],
    });
    expect(report.operations).toMatchObject([
      { operationId: 'createMerchantOrder', module: 'checkout', state: 'pending', calls: 1 },
    ]);
    expect(report.verdict.blocking).toBe(true);
    expect(report.verdict.findings[0]).toContain('merchant orders are derived from preferences');
  });

  test('with nothing pending the registry reports every used operation as emulated', () => {
    const report = buildReport({
      entries: [entry({ method: 'POST', route: '/merchant_orders', path: '/merchant_orders', status: 201 })],
      now: 1,
    });
    expect(report.operations).toMatchObject([{ operationId: 'createMerchantOrder', state: 'emulated' }]);
  });

  test('a route outside the specification is reported without blocking', () => {
    const report = buildReport({
      entries: [entry({ method: 'GET', route: '/p/ticket/:id', path: '/p/ticket/42' })],
      now: 1,
    });
    expect(report.undocumented).toEqual([{ method: 'GET', route: '/p/ticket/:id', calls: 1 }]);
    expect(report.operations).toEqual([]);
    expect(report.verdict.blocking).toBe(false);
  });

  test('the control API is not part of the report', () => {
    const report = buildReport({
      entries: [entry({ route: '/_payground/sandboxes', path: '/_payground/sandboxes' })],
      now: 1,
    });
    expect(report.requests).toBe(0);
  });

  test('only the divergences the used endpoints expose are listed', async () => {
    app = startTestServer();
    await app.api('POST', '/v1/payments', { body: pix });
    const report = buildReport({ entries: readHistory(app.storage.requests, null, Number.MAX_SAFE_INTEGER), now: 1 });
    const areas = report.divergences.map((divergence) => divergence.area);
    expect(areas).toContain('Payments');
    expect(areas).toContain('Pix');
    expect(areas).not.toContain('Merchant orders');
    expect(areas).not.toContain('Errors');
  });

  test('a live response divergence is merged into the stored one', () => {
    const report = buildReport({
      entries: [],
      now: 1,
      drift: [{ operationId: 'createPayment', status: 201, calls: 2, issues: [{ path: 'x', message: 'nope' }] }],
    });
    expect(report.responseDrift).toEqual([
      { operationId: 'createPayment', status: 201, calls: 2, issues: [{ path: 'x', message: 'nope' }] },
    ]);
  });
});

describe('control endpoint', () => {
  test('serves the report and requires the admin token', async () => {
    app = startTestServer();
    await app.api('POST', '/v1/payments', { body: { ...pix, not_a_real_field: 1 } });

    const denied = await app.control('GET', '/_payground/parity', undefined, null);
    expect(denied.status).toBe(401);

    const call = await app.control('GET', '/_payground/parity');
    expect(call.status).toBe(200);
    expect(call.body.operations[0].operationId).toBe('createPayment');
    expect(call.body.verdict.blocking).toBe(true);
  });

  test('a sandbox filter narrows the history', async () => {
    app = startTestServer();
    await app.api('POST', '/v1/payments', { body: pix });
    const other = app.storage.sandboxes.list()[0]?.id;
    expect(other).toBeString();

    const mine = await app.control('GET', `/_payground/parity?sandbox=${other ?? ''}`);
    expect(mine.body.requests).toBe(1);
    // A sandbox that does not exist must not read as a clean report.
    const missing = await app.control('GET', '/_payground/parity?sandbox=missing');
    expect(missing.status).toBe(404);
  });
});

describe('request capture', () => {
  test('the history keeps the request body the doctor needs', async () => {
    app = startTestServer();
    await app.api('POST', '/v1/payments', { body: pix, token: TEST_ACCESS_TOKEN });
    const recorded = app.storage.requests.search({}).results[0];
    expect(JSON.parse(recorded?.requestBody ?? 'null')).toEqual(pix);
  });

  test('a body over the history limit is dropped, not truncated', async () => {
    app = startTestServer({ historyBodyLimit: 10 });
    await app.api('POST', '/v1/payments', { body: pix });
    expect(app.storage.requests.search({}).results[0]?.requestBody).toBeNull();
  });

  test('a sandbox id is recorded so the doctor can filter', async () => {
    app = startTestServer();
    await app.api('GET', '/v1/payments/search');
    const recorded = app.storage.requests.search({}).results[0];
    expect(recorded?.sandbox).toBe(app.sandboxId as SandboxId);
  });
});
