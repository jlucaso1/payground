import { afterEach, describe, expect, test } from 'bun:test';
import { type TestServer, startReceiver, startTestServer } from '../testing.ts';

let app: TestServer | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

const pix = (key: string, amount: number) => ({ amount, receiver: { pix_key: key } });

const account = (amount: number) => ({
  amount,
  receiver: { bank_code: '237', branch: '0001', account: '12345-6', document: '12345678909' },
});

const batch = (entries: unknown[], total: number) => ({
  external_reference: 'P1',
  currency_id: 'BRL',
  total_amount: total,
  transactions: entries,
});

describe('payouts over HTTP', () => {
  test('creates a batch, lists it and cancels a pending transfer', async () => {
    app = startTestServer();

    const created = await app.api('POST', '/v1/payouts', {
      body: batch([pix('a@b.c', 10), account(20)], 30),
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'pending', total_amount: 30, external_reference: 'P1' });

    const id = created.body.id as string;
    const listed = await app.api('GET', `/v1/payouts/${id}/transactions`);
    expect(listed.status).toBe(200);
    expect(listed.body.paging).toEqual({ total: 2, limit: 30, offset: 0 });

    const pending = listed.body.results.find((entry: { status: string }) => entry.status === 'pending');
    const cancelled = await app.api('PUT', `/v1/payouts/${id}/transactions/${pending.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', status_detail: 'cancelled_by_collector' });

    const again = await app.api('PUT', `/v1/payouts/${id}/transactions/${pending.id}/cancel`);
    expect(again.status).toBe(409);
    expect(again.body.cause[0].code).toBe(4051);
  });

  test('refuses a total that does not match, and unknown ids', async () => {
    app = startTestServer();

    const mismatch = await app.api('POST', '/v1/payouts', { body: batch([pix('a@b.c', 10)], 11) });
    expect(mismatch.status).toBe(400);

    expect((await app.api('GET', '/v1/payouts/missing/transactions')).status).toBe(404);
    expect((await app.api('PUT', '/v1/payouts/missing/transactions/x/cancel')).status).toBe(404);
    expect((await app.api('POST', '/v1/payouts', { body: batch([pix('a@b.c', 10)], 10), token: null })).status).toBe(401);
  });

  test('a transaction intent produces a payment that the payments API also serves', async () => {
    app = startTestServer();

    const created = await app.api('POST', '/v1/transaction-intents/process', {
      body: {
        external_reference: 'PAYOUT-001',
        point_of_interaction: { type: 'PIX' },
        transaction: { amount: 100, currency_id: 'BRL', receiver: { pix_key: 'seller@shop.com' } },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'pending', external_reference: 'PAYOUT-001' });

    const paymentId = created.body.payment_id as string;
    const payment = await app.api('GET', `/v1/payments/${paymentId}`);
    expect(payment.status).toBe(200);
    expect(payment.body.payment_method_id).toBe('pix');

    const found = await app.api('GET', `/v1/transaction-intents/${created.body.id}`);
    expect(found.status).toBe(200);
    expect(found.body.payment.id).toBe(payment.body.id);

    expect((await app.api('GET', '/v1/transaction-intents/missing')).status).toBe(404);
  });

  test('an intent forwards notification_url, so its payment notifies', async () => {
    app = startTestServer();
    const receiver = startReceiver();
    try {
      const created = await app.api('POST', '/v1/transaction-intents/process', {
        body: {
          notification_url: receiver.url,
          transaction: { amount: 25, currency_id: 'BRL', receiver: { pix_key: 'seller@shop.com' } },
        },
      });
      expect(created.status).toBe(201);
      expect(await app.drainWebhooks()).toBe(1);
      expect(receiver.received[0]?.body).toMatchObject({ type: 'payment' });
    } finally {
      await receiver.stop();
    }
  });
});
