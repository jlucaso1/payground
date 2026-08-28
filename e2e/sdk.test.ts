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

  test('the SDK generates the idempotency key and a repeat does not duplicate', async () => {
    const key = crypto.randomUUID();
    const first = await payments.create({ body: pix(), requestOptions: { idempotencyKey: key } });
    const second = await payments.create({ body: pix(), requestOptions: { idempotencyKey: key } });
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
