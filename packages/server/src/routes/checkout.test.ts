import { afterEach, expect, test } from 'bun:test';
import { type TestServer, startTestServer } from '../testing.ts';

let app: TestServer | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

test('merchant orders are created and updated over HTTP', async () => {
  app = startTestServer();

  const created = await app.api('POST', '/merchant_orders', {
    body: {
      items: [{ id: 'sku-1', title: 'Coffee', quantity: 2, unit_price: 10.25 }],
      shipments: [{ cost: 4.5 }],
      external_reference: 'HTTP-1',
    },
  });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({
    total_amount: 20.5,
    shipping_cost: 4.5,
    order_status: 'payment_required',
    paid_amount: 0,
  });

  const id = created.body.id as number;
  const updated = await app.api('PUT', `/merchant_orders/${id}`, {
    body: { items: [{ title: 'Tea', quantity: 1, unit_price: 7 }], additional_info: 'note' },
  });
  expect(updated.status).toBe(200);
  expect(updated.body).toMatchObject({ total_amount: 7, additional_info: 'note' });

  const read = await app.api('GET', `/merchant_orders/${id}`);
  expect(read.body).toMatchObject({ total_amount: 7, shipping_cost: 4.5, order_status: 'payment_required' });

  const missing = await app.api('PUT', '/merchant_orders/2000000999', { body: {} });
  expect(missing.status).toBe(404);
});
