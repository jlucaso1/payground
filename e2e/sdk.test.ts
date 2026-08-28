import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { type Harness, startHarness } from './harness.ts';

let harness: Harness;
let payments: Payment;

beforeAll(async () => {
  harness = await startHarness();
  payments = new Payment(new MercadoPagoConfig({ accessToken: harness.sandbox.accessToken }));
});
afterAll(async () => {
  await harness.stop();
});

const pix = () => ({
  transaction_amount: 100.5,
  payment_method_id: 'pix',
  description: 'SDK integration test',
  payer: { email: 'payer@example.com', identification: { type: 'CPF', number: '12345678909' } },
});

describe('official SDK against payground', () => {
  test('reaches the emulator instead of the real API', async () => {
    const res = await fetch(`${harness.url}/_payground/health`);
    expect((await res.json()) as { status: string }).toMatchObject({ status: 'ok' });
  });

  test('creates a Pix payment and reads it back', async () => {
    const created = await payments.create({ body: pix() });

    expect(created.status).toBe('pending');
    expect(created.status_detail).toBe('pending_waiting_transfer');
    expect(created.payment_method_id).toBe('pix');
    expect(created.point_of_interaction?.transaction_data?.qr_code).toStartWith('000201');
    expect(typeof created.id).toBe('number');

    const fetched = await payments.get({ id: created.id as number });
    expect(fetched.id).toBe(created.id as number);
    expect(fetched.transaction_amount).toBe(100.5);
  });

  test('the SDK generates a fresh idempotency key per call', async () => {
    const first = await payments.create({ body: pix() });
    const second = await payments.create({ body: pix() });
    expect(second.id).not.toBe(first.id);
  });

  /**
   * `Payment.create` assigns `this.config.options = {...this.config.options, ...requestOptions}`,
   * so a per-call idempotency key is pinned onto the client for every later request. Use a
   * throwaway client, otherwise every subsequent create reuses the key and gets a 409.
   * https://github.com/mercadopago/sdk-nodejs — clients/payment/index.js
   */
  test('reusing an idempotency key replays instead of creating a second payment', async () => {
    const key = crypto.randomUUID();
    const client = new Payment(new MercadoPagoConfig({ accessToken: harness.sandbox.accessToken }));
    const first = await client.create({ body: pix(), requestOptions: { idempotencyKey: key } });
    const second = await client.create({ body: pix(), requestOptions: { idempotencyKey: key } });
    expect(second.id).toBe(first.id);
  });

  test('cancels a payment through the SDK', async () => {
    const created = await payments.create({ body: pix() });
    const cancelled = await payments.cancel({ id: created.id as number });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.status_detail).toBe('by_collector');
  });

  test('searches with paging', async () => {
    const page = await payments.search({ options: { limit: 2, offset: 0 } });
    expect(page.paging?.total).toBeGreaterThan(0);
    expect(page.results?.length).toBeLessThanOrEqual(2);
  });

  test('an unknown resource surfaces as a typed SDK error', async () => {
    await expect(payments.get({ id: 999_999 })).rejects.toMatchObject({ status: 404, error: 'not_found' });
  });

  test('a bad token surfaces as an authentication error', async () => {
    const bad = new Payment(new MercadoPagoConfig({ accessToken: 'TEST-nope' }));
    await expect(bad.get({ id: 1 })).rejects.toMatchObject({ status: 401 });
  });
});

describe('card payments through the official SDK', () => {
  const tokenFor = async (holderName: string) => {
    const response = await fetch(`${harness.url}/v1/card_tokens`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${harness.sandbox.accessToken}`,
        'x-idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        card_number: '5480832801033311',
        security_code: '123',
        expiration_month: 11,
        expiration_year: 2030,
        cardholder: { name: holderName, identification: { type: 'CPF', number: '12345678909' } },
      }),
    });
    const body = (await response.json()) as { id?: string };
    if (body.id === undefined) throw new Error(`tokenisation failed: ${JSON.stringify(body)}`);
    return body.id;
  };

  const card = async (holderName: string, extra: Record<string, unknown> = {}) =>
    payments.create({
      body: {
        transaction_amount: 42,
        token: await tokenFor(holderName),
        installments: 1,
        payer: { email: 'buyer@example.com', identification: { type: 'CPF', number: '12345678909' } },
        ...extra,
      },
    });

  test('APRO approves and OTHE is rejected', async () => {
    expect(await card('APRO').then((p) => [p.status, p.status_detail])).toEqual(['approved', 'accredited']);
    expect(await card('OTHE').then((p) => [p.status, p.status_detail])).toEqual([
      'rejected',
      'cc_rejected_other_reason',
    ]);
  });

  test('the documented decline codes map to their status_detail', async () => {
    const cases: [string, string][] = [
      ['FUND', 'cc_rejected_insufficient_amount'],
      ['SECU', 'cc_rejected_bad_filled_security_code'],
      ['CALL', 'cc_rejected_call_for_authorize'],
      ['EXPI', 'cc_rejected_bad_filled_date'],
      ['FORM', 'cc_rejected_bad_filled_other'],
    ];
    for (const [holder, detail] of cases) {
      const payment = await card(holder);
      expect([holder, payment.status, payment.status_detail]).toEqual([holder, 'rejected', detail]);
    }
  });

  test('capture=false authorizes and can then be captured', async () => {
    const authorized = await card('APRO', { capture: false });
    expect([authorized.status, authorized.status_detail]).toEqual(['authorized', 'pending_capture']);

    const captured = await payments.capture({ id: authorized.id as number });
    expect(captured.status).toBe('approved');
  });

  test('a refund moves an approved card payment to partially refunded', async () => {
    const approved = await card('APRO');
    const response = await fetch(`${harness.url}/v1/payments/${approved.id}/refunds`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${harness.sandbox.accessToken}`,
        'x-idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify({ amount: 10 }),
    });
    expect(response.status).toBe(201);

    const reread = await payments.get({ id: approved.id as number });
    expect([reread.status, reread.status_detail]).toEqual(['approved', 'partially_refunded']);
    expect(reread.transaction_amount_refunded).toBe(10);
  });

  test('the payment methods catalogue is available with a public key', async () => {
    const response = await fetch(`${harness.url}/v1/payment_methods?public_key=${harness.sandbox.publicKey}`);
    const body = (await response.json()) as { id: string }[];
    expect(response.status).toBe(200);
    expect(body.map((method) => method.id)).toContain('pix');
  });
});
