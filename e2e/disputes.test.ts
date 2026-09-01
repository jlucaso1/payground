import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AdvancedPayment, Chargeback, MercadoPagoConfig, Payment, PaymentRefund } from 'mercadopago';
import { type Harness, startHarness } from './harness.ts';

let harness: Harness;
let config: MercadoPagoConfig;
let payments: Payment;

beforeAll(async () => {
  harness = await startHarness();
  config = new MercadoPagoConfig({ accessToken: harness.sandbox.accessToken });
  payments = new Payment(config);
});
afterAll(async () => {
  await harness.stop();
});

const pix = (amount = 100.5) => ({
  transaction_amount: amount,
  payment_method_id: 'pix',
  description: 'dispute integration test',
  payer: { email: 'payer@example.com', identification: { type: 'CPF', number: '12345678909' } },
});

const control = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`${harness.url}/_payground/sandboxes/${harness.sandbox.id}${path}`, init);

/** The control API drives the emulator the way the acquirer drives the real API. */
async function act(sequence: number, body: Record<string, unknown>): Promise<void> {
  const listed = (await (await control('/payments?limit=100')).json()) as {
    results: { id: string; sequence: number }[];
  };
  const found = listed.results.find((payment) => payment.sequence === sequence);
  if (found === undefined) throw new Error(`no payment ${sequence}`);

  const response = await control(`/payments/${found.id}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
}

const settled = async (amount?: number): Promise<number> => {
  const created = await payments.create({ body: pix(amount) });
  const id = created.id as number;
  await act(id, { type: 'settle' });
  return id;
};

describe('chargebacks through the official SDK', () => {
  test('a disputed payment exposes a chargeback and documentation wins it', async () => {
    const id = await settled();
    await act(id, { type: 'dispute' });
    expect((await payments.get({ id })).status).toBe('in_mediation');

    const chargeback = await new Chargeback(config).get({ id: String(id) });
    expect(chargeback).toMatchObject({
      id: String(id),
      payment_id: id,
      amount: 100.5,
      status: 'pending',
      documentation_status: 'not_supplied',
    });
    expect(typeof chargeback.date_created).toBe('string');

    const response = await fetch(`${harness.url}/v1/chargebacks/${id}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${harness.sandbox.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ files: [{ name: 'invoice.pdf', url: 'https://example.com/i.pdf' }] }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { status: string }).toMatchObject({
      status: 'won',
      documentation_status: 'valid',
    });

    expect((await payments.get({ id })).status).toBe('approved');
  });

  test('an unknown chargeback is a 404', async () => {
    const response = await fetch(`${harness.url}/v1/chargebacks/999999`, {
      headers: { authorization: `Bearer ${harness.sandbox.accessToken}` },
    });
    expect(response.status).toBe(404);
  });
});

describe('the remaining payment operations', () => {
  test('PUT /v1/payments/{id}/cancellations cancels a pending payment', async () => {
    const created = await payments.create({ body: pix(42) });
    const response = await fetch(`${harness.url}/v1/payments/${created.id}/cancellations`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${harness.sandbox.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status: 'cancelled' }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as { status: string }).toMatchObject({
      id: created.id,
      status: 'cancelled',
      status_detail: 'by_collector',
    });
  });

  test('a single refund is readable by id', async () => {
    const id = await settled(80);
    const refunds = new PaymentRefund(config);
    const created = await refunds.create({ payment_id: id, body: { amount: 30 } });

    const found = await refunds.get({ payment_id: id, refund_id: created.id as number });
    expect(found).toMatchObject({ id: created.id, payment_id: id, amount: 30, status: 'approved' });
  });
});

describe('advanced payments through the official SDK', () => {
  test('splits a payment between two collectors and reads it back', async () => {
    const client = new AdvancedPayment(config);
    // The SDK types a disbursement with money_release_date; the API documents money_release_days.
    const body = {
      payments: [{ payment_method_id: 'account_money', transaction_amount: 90 }],
      disbursements: [
        { collector_id: 11, amount: 60, application_fee: 6, money_release_days: 5 },
        { collector_id: 22, amount: 30, application_fee: 3, money_release_days: 5 },
      ],
      payer: { email: 'payer@example.com' },
      external_reference: 'SPLIT-E2E',
    };
    const created = (await client.create({ body: body as never })) as {
      id?: number;
      status?: string;
      disbursements?: unknown[];
    };

    expect(created.status).toBe('approved');
    expect(created.disbursements).toHaveLength(2);

    const read = await client.get({ id: String(created.id) });
    expect(read).toMatchObject({ id: created.id, status: 'approved' });
  });
});
