import { afterEach, describe, expect, test } from 'bun:test';
import { parseBrCode } from '@payground/mercadopago/pix/index.ts';
import { type TestServer, startTestServer } from '../testing.ts';

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.stop();
});

interface Pos {
  server: TestServer;
  qrs: string;
  orders: string;
  storeOrders: string;
  v1: string;
}

/** The QR paths carry the collector id, which the preference response reports. */
async function start(): Promise<Pos> {
  const server = startTestServer();
  servers.push(server);

  const probe = await server.api('POST', '/checkout/preferences', {
    body: { items: [{ title: 'probe', quantity: 1, unit_price: 1 }] },
  });
  const user = probe.body.collector_id;

  return {
    server,
    qrs: `/instore/orders/qr/seller/collectors/${user}/pos/POS1/qrs`,
    orders: `/instore/qr/seller/collectors/${user}/pos/POS1/orders`,
    storeOrders: `/instore/qr/seller/collectors/${user}/stores/STORE1/pos/POS1/orders`,
    v1: `/mpmobile/instore/qr/${user}/POS1`,
  };
}

const order = (overrides: Record<string, unknown> = {}) => ({
  external_reference: 'REF-1',
  title: 'Coffee shop',
  description: 'Two coffees',
  total_amount: 20.5,
  items: [
    {
      title: 'Coffee',
      quantity: 2,
      unit_price: 10.25,
      unit_measure: 'unit',
      total_amount: 20.5,
    },
  ],
  ...overrides,
});

/** Approves the pending Pix payment the QR order created, as a scan would. */
async function settle(server: TestServer, paymentSequence: number): Promise<void> {
  const listed = await server.control('GET', `/_payground/sandboxes/${server.sandboxId}/payments`);
  const found = listed.body.results.find((entry: { sequence: number }) => entry.sequence === paymentSequence);
  expect(found).toBeDefined();
  const acted = await server.control(
    'POST',
    `/_payground/sandboxes/${server.sandboxId}/payments/${found.id}/actions`,
    { type: 'settle' },
  );
  expect(acted.status).toBe(200);
}

describe('dynamic QR', () => {
  test('answers with an order id and a valid Pix BR Code', async () => {
    const { server, qrs } = await start();
    const created = await server.api('POST', qrs, { body: order() });

    expect(created.status).toBe(200);
    expect(typeof created.body.in_store_order_id).toBe('string');
    expect(parseBrCode(created.body.qr_data).ok).toBe(true);
  });

  test('PUT and POST share the same behaviour', async () => {
    const { server, qrs, orders } = await start();
    const put = await server.api('PUT', qrs, { body: order({ external_reference: 'REF-PUT' }) });

    expect(put.status).toBe(200);
    const read = await server.api('GET', orders);
    expect(read.body.external_reference).toBe('REF-PUT');
  });

  test('rejects a total that does not match the items', async () => {
    const { server, qrs } = await start();
    const created = await server.api('POST', qrs, { body: order({ total_amount: 30 }) });

    expect(created.status).toBe(400);
    expect(created.body.cause[0].description).toContain('total_amount');
  });

  test('rejects a currency Pix cannot settle and a malformed cash out', async () => {
    const { server, qrs } = await start();
    const currency = await server.api('POST', qrs, {
      body: order({ items: [{ title: 'Coffee', quantity: 2, unit_price: 10.25, currency_id: 'USD' }] }),
    });
    expect(currency.status).toBe(400);

    const cashOut = await server.api('POST', qrs, { body: order({ cash_out: { amount: '5.00' } }) });
    expect(cashOut.status).toBe(400);
  });

  test('rejects a collector that is not the token owner', async () => {
    const { server } = await start();
    const foreign = await server.api('POST', '/instore/orders/qr/seller/collectors/999/pos/POS1/qrs', {
      body: order(),
    });
    expect(foreign.status).toBe(403);

    const malformed = await server.api('POST', '/instore/orders/qr/seller/collectors/abc/pos/POS1/qrs', {
      body: order(),
    });
    expect(malformed.status).toBe(400);
  });
});

describe('in-store orders', () => {
  test('carries the order, its items and a merchant order', async () => {
    const { server, qrs, orders } = await start();
    await server.api('POST', qrs, { body: order() });
    const read = await server.api('GET', orders);

    expect(read.status).toBe(200);
    expect(read.body.external_reference).toBe('REF-1');
    expect(read.body.title).toBe('Coffee shop');
    expect(read.body.total_amount).toBe(20.5);
    expect(read.body.items).toEqual([
      {
        sku_number: null,
        category: null,
        title: 'Coffee',
        description: null,
        unit_price: 10.25,
        quantity: 2,
        unit_measure: 'unit',
        total_amount: 20.5,
        currency_id: 'BRL',
      },
    ]);
    expect(read.body.status).toBe('opened');
    expect(read.body.order_status).toBe('payment_required');

    const merchant = await server.api('GET', `/merchant_orders/${read.body.merchant_order_id}`);
    expect(merchant.status).toBe(200);
    expect(merchant.body.total_amount).toBe(20.5);
  });

  test('reading the order twice leaves the merchant order untouched', async () => {
    const { server, qrs, orders } = await start();
    await server.api('POST', qrs, { body: order() });
    const read = await server.api('GET', orders);
    const before = await server.api('GET', `/merchant_orders/${read.body.merchant_order_id}`);

    server.clock.advance(3_600_000);
    await server.api('GET', orders);
    const after = await server.api('GET', `/merchant_orders/${read.body.merchant_order_id}`);

    expect(after.body.payments).toEqual(before.body.payments);
  });

  test('closes the order once its payment is collected', async () => {
    const { server, qrs, orders } = await start();
    await server.api('POST', qrs, { body: order() });
    const opened = await server.api('GET', orders);

    await settle(server, opened.body.payment_id);
    const closed = await server.api('GET', orders);

    expect(closed.body.status).toBe('closed');
    expect(closed.body.order_status).toBe('paid');
    expect(closed.body.payment_status).toBe('approved');

    const payment = await server.api('GET', `/v1/payments/${opened.body.payment_id}`);
    expect(payment.body.status).toBe('approved');

    const merchant = await server.api('GET', `/merchant_orders/${closed.body.merchant_order_id}`);
    expect(merchant.body.paid_amount).toBe(20.5);
  });

  test('a POS holds one order: a second one replaces the first', async () => {
    const { server, qrs, orders } = await start();
    await server.api('POST', qrs, { body: order() });
    const first = await server.api('GET', orders);

    await server.api('POST', qrs, { body: order({ external_reference: 'REF-2' }) });
    const second = await server.api('GET', orders);

    expect(second.body.external_reference).toBe('REF-2');
    expect(second.body.payment_id).not.toBe(first.body.payment_id);

    const replaced = await server.api('GET', `/v1/payments/${first.body.payment_id}`);
    expect(replaced.body.status).toBe('cancelled');

    const abandoned = await server.api('GET', `/merchant_orders/${first.body.merchant_order_id}`);
    expect(abandoned.body.payments[0].status).toBe('cancelled');
  });

  test('a rejected replacement leaves the live order in place', async () => {
    const { server, qrs, orders } = await start();
    await server.api('POST', qrs, { body: order() });
    const before = await server.api('GET', orders);

    const rejected = await server.api('POST', qrs, { body: order({ total_amount: 30 }) });
    expect(rejected.status).toBe(400);

    const after = await server.api('GET', orders);
    expect(after.body.payment_id).toBe(before.body.payment_id);

    const payment = await server.api('GET', `/v1/payments/${before.body.payment_id}`);
    expect(payment.body.status).toBe('pending');
  });

  test('deleting the order clears the POS and cancels its payment', async () => {
    const { server, qrs, orders } = await start();
    await server.api('POST', qrs, { body: order() });
    const opened = await server.api('GET', orders);

    const deleted = await server.api('DELETE', orders);
    expect(deleted.status).toBe(200);

    const missing = await server.api('GET', orders);
    expect(missing.status).toBe(404);

    const payment = await server.api('GET', `/v1/payments/${opened.body.payment_id}`);
    expect(payment.body.status).toBe('cancelled');
  });

  test('a paid order cannot be deleted', async () => {
    const { server, qrs, orders } = await start();
    await server.api('POST', qrs, { body: order() });
    const opened = await server.api('GET', orders);
    await settle(server, opened.body.payment_id);

    const deleted = await server.api('DELETE', orders);
    expect(deleted.status).toBe(400);
    expect((await server.api('GET', orders)).body.status).toBe('closed');
  });

  test('expires the order and its payment at expiration_date', async () => {
    const { server, qrs, orders } = await start();
    const expiration = new Date(server.clock.now() + 600_000).toISOString();
    await server.api('POST', qrs, { body: order({ expiration_date: expiration }) });
    const opened = await server.api('GET', orders);
    expect(opened.body.status).toBe('opened');

    server.clock.advance(600_001);
    const expired = await server.api('GET', orders);

    expect(expired.body.status).toBe('expired');
    expect(expired.body.payment_status).toBe('cancelled');
    expect((await server.api('GET', `/v1/payments/${opened.body.payment_id}`)).body.status).toBe('cancelled');
  });

  test('the deprecated V1 and V2 endpoints create and delete the same order', async () => {
    const { server, storeOrders, v1, orders } = await start();

    const v2 = await server.api('PUT', storeOrders, { body: order({ external_reference: 'REF-V2' }) });
    expect(v2.status).toBe(200);
    expect(v2.body.external_store_id).toBe('STORE1');
    expect(parseBrCode(v2.body.qr_data).ok).toBe(true);

    const created = await server.api('PUT', v1, { body: order({ external_reference: 'REF-V1' }) });
    expect(created.status).toBe(200);
    expect(created.body.external_store_id).toBeNull();

    const read = await server.api('GET', orders);
    expect(read.body.external_reference).toBe('REF-V1');

    expect((await server.api('DELETE', v1)).status).toBe(200);
    expect((await server.api('GET', orders)).status).toBe(404);
    expect((await server.api('DELETE', v1)).status).toBe(404);
  });
});

describe('integrator configuration', () => {
  test('stores the callback url and hands it to new orders', async () => {
    const { server, qrs, orders } = await start();
    const empty = await server.api('GET', '/instore/integrator');
    expect(empty.body.callback_url).toBeNull();

    const patched = await server.api('PATCH', '/instore/integrator', {
      body: { callback_url: 'https://example.test/qr' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.callback_url).toBe('https://example.test/qr');

    const read = await server.api('GET', '/instore/integrator');
    expect(read.body.callback_url).toBe('https://example.test/qr');

    await server.api('POST', qrs, { body: order() });
    const created = await server.api('GET', orders);
    expect(created.body.notification_url).toBe('https://example.test/qr');
  });

  test('falls back to the deprecated notification_url', async () => {
    const { server, qrs, orders } = await start();
    await server.api('PATCH', '/instore/integrator', {
      body: { notification_url: 'https://example.test/notify' },
    });

    await server.api('POST', qrs, { body: order() });
    const created = await server.api('GET', orders);
    expect(created.body.notification_url).toBe('https://example.test/notify');
  });

  test('rejects a callback url that is not http(s)', async () => {
    const { server } = await start();
    const patched = await server.api('PATCH', '/instore/integrator', { body: { callback_url: 'ftp://x' } });

    expect(patched.status).toBe(400);
  });
});

describe('cash out confirmation', () => {
  test('confirms the cash out of an existing merchant order once', async () => {
    const { server, qrs, orders } = await start();
    await server.api('POST', qrs, { body: order({ cash_out: { amount: 5 } }) });
    const read = await server.api('GET', orders);

    const confirmed = await server.api('POST', `/instore/orders/${read.body.merchant_order_id}/confirmation`, {
      body: { status: 'confirmed' },
    });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.cash_out).toEqual({ amount: 5, status: 'confirmed' });
    expect((await server.api('GET', orders)).body.cash_out.status).toBe('confirmed');

    const again = await server.api('POST', `/instore/orders/${read.body.merchant_order_id}/confirmation`, {
      body: { status: 'cancelled' },
    });
    expect(again.status).toBe(409);
  });

  test('rejects an unknown status, an order without cash out and an unknown merchant order', async () => {
    const { server, qrs, orders } = await start();
    await server.api('POST', qrs, { body: order({ cash_out: { amount: 5 } }) });
    const read = await server.api('GET', orders);
    const path = `/instore/orders/${read.body.merchant_order_id}/confirmation`;

    expect((await server.api('POST', path, { body: { status: 'refunded' } })).status).toBe(400);

    await server.api('POST', qrs, { body: order() });
    const without = await server.api('GET', orders);
    const plain = await server.api('POST', `/instore/orders/${without.body.merchant_order_id}/confirmation`, {
      body: { status: 'confirmed' },
    });
    expect(plain.status).toBe(400);

    const missing = await server.api('POST', '/instore/orders/999/confirmation', {
      body: { status: 'confirmed' },
    });
    expect(missing.status).toBe(404);
  });
});
