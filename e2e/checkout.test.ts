import { afterEach, describe, expect, test } from 'bun:test';
import { MercadoPagoConfig, MerchantOrder, Preference } from 'mercadopago';
import { createServer } from '@payground/server';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function scenario() {
  const server = createServer({ port: 0, deliveryIntervalMs: 0 });
  const sandbox = server.app.defaultSandbox;
  if (sandbox === null) throw new Error('expected a bootstrapped sandbox');

  const { AppConfig } = (await import('mercadopago/dist/utils/config')) as { AppConfig: { BASE_URL: string } };
  AppConfig.BASE_URL = server.url.origin;
  close = async () => {
    await server.stop(true);
  };

  const config = new MercadoPagoConfig({ accessToken: sandbox.accessToken });
  return {
    origin: server.url.origin,
    preferences: new Preference(config),
    merchantOrders: new MerchantOrder(config),
  };
}

const body = {
  items: [
    { id: 'sku-1', title: 'A thing', quantity: 2, unit_price: 25.5, currency_id: 'BRL' },
    { id: 'sku-2', title: 'Another thing', quantity: 1, unit_price: 49, currency_id: 'BRL' },
  ],
  payer: { email: 'buyer@example.com' },
  external_reference: 'ORDER-CHK-1',
  back_urls: {
    success: 'https://shop.example.com/ok',
    failure: 'https://shop.example.com/fail',
    pending: 'https://shop.example.com/pending',
  },
};

describe('Checkout Pro through the official SDK', () => {
  test('a preference exposes an init_point on this instance', async () => {
    const app = await scenario();
    const created = await app.preferences.create({ body });

    expect(created.id).toBeString();
    expect(created.init_point).toBe(`${app.origin}/checkout/${created.id as string}`);
    expect(created.sandbox_init_point).toBe(created.init_point as string);
    expect(created.external_reference).toBe('ORDER-CHK-1');

    const fetched = await app.preferences.get({ preferenceId: created.id as string });
    expect(fetched.id).toBe(created.id as string);
  });

  test('the hosted page renders the items and escapes hostile input', async () => {
    const app = await scenario();
    const created = await app.preferences.create({
      body: {
        ...body,
        items: [{ id: 'x', title: '</script><img src=x onerror=alert(1)>', quantity: 1, unit_price: 10, currency_id: 'BRL' }],
      },
    });

    const response = await fetch(created.init_point as string);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;/script&gt;');
    expect(html).toContain('outcome');
  });

  test('paying on the hosted page creates a payment and redirects back', async () => {
    const app = await scenario();
    const created = await app.preferences.create({ body });

    const response = await fetch(created.init_point as string, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ outcome: 'card_approved' }).toString(),
      redirect: 'manual',
    });

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') as string);
    expect(location.origin + location.pathname).toBe('https://shop.example.com/ok');
    expect(location.searchParams.get('collection_status')).toBe('approved');
    expect(location.searchParams.get('external_reference')).toBe('ORDER-CHK-1');
    expect(location.searchParams.get('preference_id')).toBe(created.id as string);
    expect(location.searchParams.get('payment_id')).toBeString();

    const orderId = location.searchParams.get('merchant_order_id') as string;
    const order = await app.merchantOrders.get({ merchantOrderId: orderId });
    expect(order.preference_id).toBe(created.id as string);
    expect(order.total_amount).toBe(100);
    expect(order.paid_amount).toBe(100);
    expect(order.order_status).toBe('paid');
    expect(order.payments).toHaveLength(1);
  });

  test('a pending Pix leaves the order awaiting payment', async () => {
    const app = await scenario();
    const created = await app.preferences.create({ body });

    const response = await fetch(created.init_point as string, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ outcome: 'pix' }).toString(),
      redirect: 'manual',
    });

    const location = new URL(response.headers.get('location') as string);
    expect(location.origin + location.pathname).toBe('https://shop.example.com/pending');
    expect(location.searchParams.get('collection_status')).toBe('pending');

    const order = await app.merchantOrders.get({
      merchantOrderId: location.searchParams.get('merchant_order_id') as string,
    });
    expect(order.order_status).toBe('payment_required');
    expect(order.paid_amount).toBe(0);
  });

  test('an unknown preference is a 404 in the provider envelope', async () => {
    const app = await scenario();
    const response = await fetch(`${app.origin}/checkout/does-not-exist`);
    expect(response.status).toBe(404);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'not_found' });
  });
});
