import { afterEach, describe, expect, test } from 'bun:test';
import { type TestServer, startTestServer } from '../testing.ts';

let app: TestServer | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

const pix = { transaction_amount: 100, payment_method_id: 'pix', payer: { email: 'a@b.c' } };

describe('strict mode', () => {
  test('refuses an undocumented field and leaves no payment behind', async () => {
    app = startTestServer({ strict: true });
    const call = await app.api('POST', '/v1/payments', { body: { ...pix, not_a_real_field: 1 } });
    expect(call.status).toBe(400);
    expect(call.body).toMatchObject({ error: 'bad_request' });
    expect(JSON.stringify(call.body.cause)).toContain('not_a_real_field');
    expect((await app.api('GET', '/v1/payments/search')).body.paging.total).toBe(0);
  });

  test('refuses a missing required field and a value outside an enum', async () => {
    app = startTestServer({ strict: true });
    expect((await app.api('POST', '/v1/payments', { body: { payer: { email: 'a@b.c' } } })).status).toBe(400);
    expect((await app.api('POST', '/v1/payments', { body: { ...pix, three_ds_mode: 'sometimes' } })).status).toBe(400);
  });

  test('accepts a documented body', async () => {
    app = startTestServer({ strict: true });
    expect((await app.api('POST', '/v1/payments', { body: pix })).status).toBe(201);
  });

  test('an unauthenticated call still fails on the credentials, not on the body', async () => {
    app = startTestServer({ strict: true });
    const call = await app.api('POST', '/v1/payments', { body: { ...pix, not_a_real_field: 1 }, token: null });
    expect(call.status).toBe(401);
  });

  test('a body only the emulator understands passes when strict mode is off', async () => {
    app = startTestServer();
    expect((await app.api('POST', '/v1/payments', { body: { ...pix, not_a_real_field: 1 } })).status).toBe(201);
  });

  test('a refusal is recorded, so the doctor sees the call strict mode caught', async () => {
    app = startTestServer({ strict: true });
    expect((await app.api('POST', '/v1/payments', { body: { ...pix, not_a_real_field: 1 } })).status).toBe(400);

    const recorded = app.storage.requests.search({}).results[0];
    expect(recorded).toMatchObject({ method: 'POST', route: '/v1/payments', status: 400 });
    expect(recorded?.requestBody).toContain('not_a_real_field');
    expect(app.metrics.counterSamples().some((sample) => sample.labels['status'] === '400')).toBe(true);

    const report = (await app.control('GET', '/_payground/parity')).body;
    expect(report.verdict.blocking).toBe(true);
  });

  test('an injected outage still wins over the body check', async () => {
    app = startTestServer({ strict: true });
    await app.control('PUT', `/_payground/sandboxes/${app.sandboxId}/faults`, { unavailable: true });
    const call = await app.api('POST', '/v1/payments', { body: { ...pix, not_a_real_field: 1 } });
    expect(call.status).toBe(503);
  });

  test('card data never reaches the request history', async () => {
    app = startTestServer();
    await app.api('POST', '/v1/card_tokens', {
      body: { card_number: '5031433215406351', security_code: '123', expiration_month: 11, expiration_year: 2030, cardholder: { name: 'APRO' } },
    });
    const recorded = app.storage.requests.search({}).results[0]?.requestBody ?? '';
    expect(recorded).not.toContain('5031433215406351');
    expect(recorded).not.toContain('"123"');
    expect(JSON.parse(recorded)).toMatchObject({ card_number: '***', security_code: '***', cardholder: { name: 'APRO' } });
  });

  test('a response that diverges from the specification is recorded, not failed', async () => {
    app = startTestServer({ strict: true });
    expect((await app.api('POST', '/v1/payments', { body: pix })).status).toBe(201);
    expect((await app.api('GET', '/v1/payments/search')).status).toBe(200);

    const report = (await app.control('GET', '/_payground/parity')).body;
    const drift = report.responseDrift.find((entry: { operationId: string }) => entry.operationId === 'searchPayments');
    // The documented divergence: search returns the payment id as a string.
    expect(drift).toMatchObject({ status: 200, calls: 1 });
    expect(drift.issues).toContainEqual({ path: 'results[].id', message: 'expected integer' });
    expect(report.verdict.blocking).toBe(false);
  });
});
