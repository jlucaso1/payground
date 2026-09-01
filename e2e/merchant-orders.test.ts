import { afterEach, describe, expect, test } from 'bun:test';
import { MercadoPagoConfig, MerchantOrder, Payment, Preference } from 'mercadopago';
import { type Harness, startHarness } from './harness.ts';

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.stop();
  harness = null;
});

async function scenario() {
  const app = await startHarness();
  harness = app;
  const config = new MercadoPagoConfig({ accessToken: app.sandbox.accessToken });

  /** The SDK has no tokenisation client, so the card token is taken over plain HTTP. */
  const cardToken = async (holderName: string): Promise<string> => {
    const response = await fetch(`${app.url}/v1/card_tokens`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${app.sandbox.accessToken}`,
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

  return {
    merchantOrders: new MerchantOrder(config),
    preferences: new Preference(config),
    payments: new Payment(config),
    cardToken,
  };
}

const items = [
  { id: 'sku-1', title: 'A thing', quantity: 2, unit_price: 25.5, currency_id: 'BRL' },
  { id: 'sku-2', title: 'Another thing', quantity: 1, unit_price: 49, currency_id: 'BRL' },
];

describe('Merchant orders through the official SDK', () => {
  test('a directly created order totals its items and stays payment_required', async () => {
    const app = await scenario();

    const created = await app.merchantOrders.create({
      body: {
        items,
        external_reference: 'ORDER-MO-1',
        additional_info: 'created by the SDK',
        // The SDK types payer as `{ id, nickname }`, while the spec documents `{ id, email }`.
        payer: { id: 42, nickname: 'buyer' },
      },
    });

    expect(created.payer).toEqual({ id: 42, nickname: 'buyer' } as never);
    expect(created.total_amount).toBe(100);
    expect(created.paid_amount).toBe(0);
    expect(created.order_status).toBe('payment_required');
    expect(created.status).toBe('opened');
    expect(created.external_reference).toBe('ORDER-MO-1');

    const fetched = await app.merchantOrders.get({ merchantOrderId: created.id as number });
    expect(fetched.total_amount).toBe(100);
  });

  test('an update replaces the cart and attaching a payment closes the order', async () => {
    const app = await scenario();
    const created = await app.merchantOrders.create({ body: { items } });

    const updated = await app.merchantOrders.update({
      merchantOrderId: created.id as number,
      body: {
        items: [{ id: 'sku-3', title: 'Just one', quantity: 1, unit_price: 40, currency_id: 'BRL' }],
        additional_info: 'updated by the SDK',
      },
    });
    expect(updated.total_amount).toBe(40);
    expect(updated.order_status).toBe('payment_required');
    expect(updated.additional_info).toBe('updated by the SDK');

    const payment = await app.payments.create({
      body: {
        transaction_amount: 25,
        token: await app.cardToken('APRO'),
        installments: 1,
        payer: { email: 'buyer@example.com', identification: { type: 'CPF', number: '12345678909' } },
      },
    });
    expect(payment.status).toBe('approved');

    const partial = await app.merchantOrders.update({
      merchantOrderId: created.id as number,
      body: { payments: [{ id: payment.id }] } as never,
    });
    expect(partial.paid_amount).toBe(25);
    expect(partial.order_status).toBe('partially_paid');

    const rest = await app.payments.create({
      body: {
        transaction_amount: 15,
        token: await app.cardToken('APRO'),
        installments: 1,
        payer: { email: 'buyer@example.com', identification: { type: 'CPF', number: '12345678909' } },
      },
    });

    const settled = await app.merchantOrders.update({
      merchantOrderId: created.id as number,
      body: { payments: [{ id: rest.id }] } as never,
    });
    expect(settled.total_amount).toBe(40);
    expect(settled.paid_amount).toBe(40);
    expect(settled.order_status).toBe('paid');
    expect(settled.status).toBe('closed');
    expect(settled.payments).toHaveLength(2);
  });

  test('an order created from a preference keeps mirroring it', async () => {
    const app = await scenario();
    const preference = await app.preferences.create({
      body: { items, external_reference: 'ORDER-MO-2' },
    });

    const order = await app.merchantOrders.create({
      body: { preference_id: preference.id as string },
    });
    expect(order.preference_id).toBe(preference.id as string);
    expect(order.total_amount).toBe(100);
    expect(order.paid_amount).toBe(0);
    expect(order.order_status).toBe('payment_required');

    const response = await fetch(preference.init_point as string, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ outcome: 'card_approved' }).toString(),
      redirect: 'manual',
    });
    expect(response.status).toBe(200);

    const settled = await app.merchantOrders.get({ merchantOrderId: order.id as number });
    expect(settled.total_amount).toBe(100);
    expect(settled.paid_amount).toBe(100);
    expect(settled.order_status).toBe('paid');
    expect(settled.status).toBe('closed');
  });
});
