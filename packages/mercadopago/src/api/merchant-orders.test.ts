import { describe, expect, test } from 'bun:test';
import { type JsonObject, type Result, isJsonObject, unwrap } from '@payground/core';
import type { ErrorBody } from '../errors.ts';
import { testContext } from '../testing.ts';
import { createCardToken } from './card-tokens.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { cardPaymentBody, cardTokenBody } from './fixture.ts';
import {
  attachPayment,
  createMerchantOrder,
  getMerchantOrder,
  orderForPreference,
  orderStatusOf,
  searchMerchantOrders,
  updateMerchantOrder,
} from './merchant-orders.ts';
import { createPayment, createRefund, updatePayment } from './payments.ts';
import { createPreference } from './preferences.ts';

function preference(context: ServiceContext, overrides: Record<string, unknown> = {}): string {
  const result = createPreference(context, {
    items: [{ title: 'Coffee', quantity: 2, unit_price: 10.25 }],
    ...overrides,
  });
  if (!result.ok || !isJsonObject(result.value.body)) throw new Error('expected success');
  return result.value.body['id'] as string;
}

const doc = (context: ServiceContext, id: string): JsonObject => {
  const order = orderForPreference(context, id);
  if (order === null) throw new Error('expected a merchant order');
  return order.doc;
};

describe('orderStatusOf', () => {
  const base = { dueMinor: 1000, paidMinor: 0, refundedMinor: 0, expired: false };

  test('is payment_required while nothing has been collected', () => {
    expect(orderStatusOf(base)).toBe('payment_required');
  });

  test('is partially_paid below the total and paid at or above it', () => {
    expect(orderStatusOf({ ...base, paidMinor: 400 })).toBe('partially_paid');
    expect(orderStatusOf({ ...base, paidMinor: 1000 })).toBe('paid');
    expect(orderStatusOf({ ...base, paidMinor: 1200 })).toBe('paid');
  });

  test('separates a partial reversal from a full one', () => {
    expect(orderStatusOf({ ...base, paidMinor: 1000, refundedMinor: 400 })).toBe('partially_refunded');
    expect(orderStatusOf({ ...base, paidMinor: 1000, refundedMinor: 1000 })).toBe('refunded');
  });

  test('expires only while the amount due is outstanding', () => {
    expect(orderStatusOf({ ...base, expired: true })).toBe('expired');
    expect(orderStatusOf({ ...base, paidMinor: 400, expired: true })).toBe('expired');
    expect(orderStatusOf({ ...base, paidMinor: 1000, expired: true })).toBe('paid');
  });
});

describe('attachPayment', () => {
  test('creates the order on the first payment, not with the preference', () => {
    const { context } = testContext();
    const id = preference(context);
    expect(orderForPreference(context, id)).toBeNull();

    attachPayment(context, id, 1_000_000_001, 'pending', 20.5);
    const order = orderForPreference(context, id);
    expect(order?.sequence).toBe(2_000_000_001);
    expect(order?.doc['preference_id']).toBe(id);
  });

  test('carries the preference total, shipping cost and items', () => {
    const { context } = testContext();
    const id = preference(context, {
      shipments: { mode: 'not_specified', cost: 4.5 },
      external_reference: 'cart-9',
    });
    attachPayment(context, id, 1_000_000_001, 'pending', 25);

    const order = doc(context, id);
    expect(order['total_amount']).toBe(20.5);
    expect(order['shipping_cost']).toBe(4.5);
    expect(order['external_reference']).toBe('cart-9');
    expect((order['items'] as JsonObject[])[0]?.['title']).toBe('Coffee');
  });

  test('tracks paid_amount and closes the order once it covers the total', () => {
    const { context } = testContext();
    const id = preference(context);
    attachPayment(context, id, 1_000_000_001, 'pending', 20.5);
    expect(doc(context, id)['order_status']).toBe('payment_required');
    expect(doc(context, id)['paid_amount']).toBe(0);

    attachPayment(context, id, 1_000_000_001, 'approved', 20.5);
    const order = doc(context, id);
    expect(order['order_status']).toBe('paid');
    expect(order['status']).toBe('closed');
    expect(order['paid_amount']).toBe(20.5);
    expect(order['payments']).toHaveLength(1);
  });

  test('updates a payment in place instead of appending a duplicate', () => {
    const { context } = testContext();
    const id = preference(context);
    attachPayment(context, id, 1_000_000_001, 'pending', 20.5);
    attachPayment(context, id, 1_000_000_001, 'rejected', 20.5);
    const payments = doc(context, id)['payments'] as JsonObject[];
    expect(payments).toHaveLength(1);
    expect(payments[0]?.['status']).toBe('rejected');
  });

  test('sums several payments into partially_paid then paid', () => {
    const { context } = testContext();
    const id = preference(context);
    attachPayment(context, id, 1_000_000_001, 'approved', 10);
    expect(doc(context, id)['order_status']).toBe('partially_paid');

    attachPayment(context, id, 1_000_000_002, 'approved', 10.5);
    expect(doc(context, id)['order_status']).toBe('paid');
    expect(doc(context, id)['paid_amount']).toBe(20.5);
  });

  test('reports refunded and partially_refunded from the payment statuses', () => {
    const { context } = testContext();
    const id = preference(context);
    attachPayment(context, id, 1_000_000_001, 'approved', 10);
    attachPayment(context, id, 1_000_000_002, 'approved', 10.5);
    attachPayment(context, id, 1_000_000_001, 'refunded', 10);

    let order = doc(context, id);
    expect(order['order_status']).toBe('partially_refunded');
    expect(order['refunded_amount']).toBe(10);
    expect(order['paid_amount']).toBe(20.5);

    attachPayment(context, id, 1_000_000_002, 'refunded', 10.5);
    order = doc(context, id);
    expect(order['order_status']).toBe('refunded');
    expect(order['refunded_amount']).toBe(20.5);
  });

  test('treats a chargeback as a full reversal even without a refunded amount', () => {
    const { context } = testContext();
    const id = preference(context);
    attachPayment(context, id, 1_000_000_001, 'approved', 20.5);
    attachPayment(context, id, 1_000_000_001, 'charged_back', 20.5);

    const order = doc(context, id);
    expect(order['refunded_amount']).toBe(20.5);
    expect(order['order_status']).toBe('refunded');
  });

  test('does nothing when the preference does not exist', () => {
    const { context } = testContext();
    attachPayment(context, 'missing', 1, 'approved', 10);
    expect(orderForPreference(context, 'missing')).toBeNull();
  });
});

describe('expiry', () => {
  test('is derived on read from the preference window', () => {
    const { context, clock } = testContext();
    const id = preference(context, {
      expires: true,
      expiration_date_to: new Date(1_700_000_600_000).toISOString(),
    });
    attachPayment(context, id, 1_000_000_001, 'pending', 20.5);
    expect(doc(context, id)['order_status']).toBe('payment_required');

    clock.advance(600_000);
    const order = doc(context, id);
    expect(order['order_status']).toBe('expired');
    expect(order['status']).toBe('expired');
  });
});

describe('getMerchantOrder / searchMerchantOrders', () => {
  test('reads the order by its numeric id', () => {
    const { context } = testContext();
    const id = preference(context);
    attachPayment(context, id, 1_000_000_001, 'approved', 20.5);

    const found = getMerchantOrder(context, '2000000001');
    if (!found.ok || !isJsonObject(found.value.body)) throw new Error('expected success');
    expect(found.value.body['id']).toBe(2_000_000_001);
    expect(found.value.body['order_status']).toBe('paid');
  });

  test('reports 404 for an unknown or non-numeric id', () => {
    const { context } = testContext();
    expect(getMerchantOrder(context, '2000000009').ok).toBe(false);
    expect(getMerchantOrder(context, 'abc').ok).toBe(false);
  });

  test('searches by preference id, external reference and status', () => {
    const { context } = testContext();
    const first = preference(context, { external_reference: 'A' });
    const second = preference(context, { external_reference: 'B' });
    attachPayment(context, first, 1_000_000_001, 'approved', 20.5);
    attachPayment(context, second, 1_000_000_002, 'pending', 20.5);

    const byPreference = searchMerchantOrders(context, new URLSearchParams(`preference_id=${first}`));
    if (!byPreference.ok || !isJsonObject(byPreference.value.body)) throw new Error('expected success');
    expect(byPreference.value.body['total']).toBe(1);
    expect(byPreference.value.body['next_offset']).toBe(1);

    const byReference = searchMerchantOrders(context, new URLSearchParams('external_reference=B'));
    expect(byReference.ok && isJsonObject(byReference.value.body) && byReference.value.body['total']).toBe(1);

    const closed = searchMerchantOrders(context, new URLSearchParams('status=closed'));
    expect(closed.ok && isJsonObject(closed.value.body) && closed.value.body['total']).toBe(1);
  });

  test('rejects a non-numeric offset', () => {
    const { context } = testContext();
    expect(searchMerchantOrders(context, new URLSearchParams('offset=abc')).ok).toBe(false);
  });
});

const created = (result: Result<Rendered, ErrorBody>): JsonObject => {
  if (!result.ok || !isJsonObject(result.value.body)) throw new Error('expected success');
  return result.value.body;
};

const failure = (result: Result<Rendered, ErrorBody>): ErrorBody => {
  if (result.ok) throw new Error('expected a failure');
  return result.error;
};

/** An approved card payment, so an update can attach a real payment id. */
function approvedPayment(context: ServiceContext, amount: number): number {
  const token = unwrap(createCardToken(context, cardTokenBody({ cardholder: { name: 'APRO' } })))
    .body as { id?: string };
  const payment = unwrap(createPayment(context, cardPaymentBody(token.id ?? '', { transaction_amount: amount })))
    .body as { id: number };
  return payment.id;
}

const ITEMS = [
  { id: 'sku-1', title: 'Coffee', quantity: 2, unit_price: 10.25 },
  { id: 'sku-2', title: 'Mug', quantity: 1, unit_price: 9.5 },
];

describe('createMerchantOrder', () => {
  test('sums the items and the shipments into the totals', () => {
    const { context } = testContext();
    const order = created(
      createMerchantOrder(context, {
        items: ITEMS,
        shipments: [{ id: 'ship-1', cost: 4.5 }],
        external_reference: 'ORDER-1',
        additional_info: 'note',
        payer: { email: 'buyer@example.com' },
      }),
    );

    expect(order['id']).toBe(2_000_000_001);
    expect(order['total_amount']).toBe(30);
    expect(order['shipping_cost']).toBe(4.5);
    expect(order['order_status']).toBe('payment_required');
    expect(order['status']).toBe('opened');
    expect(order['paid_amount']).toBe(0);
    expect(order['preference_id']).toBeNull();
    expect(order['site_id']).toBe('MLB');
    expect(order['external_reference']).toBe('ORDER-1');
    expect(order['additional_info']).toBe('note');
    expect(order['payer']).toEqual({ email: 'buyer@example.com' });
  });

  test('is readable back by id and searchable by external reference', () => {
    const { context } = testContext();
    createMerchantOrder(context, { items: ITEMS, external_reference: 'ORDER-2' });

    expect(created(getMerchantOrder(context, '2000000001'))['total_amount']).toBe(30);
    const found = created(searchMerchantOrders(context, new URLSearchParams('external_reference=ORDER-2')));
    expect(found['total']).toBe(1);
  });

  test('mirrors the preference when one is given and refuses a rival cart', () => {
    const { context } = testContext();
    const id = preference(context, { external_reference: 'cart-1' });

    const order = created(createMerchantOrder(context, { preference_id: id }));
    expect(order['preference_id']).toBe(id);
    expect(order['total_amount']).toBe(20.5);
    expect(order['external_reference']).toBe('cart-1');
    expect(orderForPreference(context, id)?.sequence).toBe(2_000_000_001);

    expect(failure(createMerchantOrder(context, { preference_id: id })).status).toBe(409);

    const other = preference(context);
    expect(failure(createMerchantOrder(context, { preference_id: other, items: ITEMS })).status).toBe(400);
  });

  test('a payment on the preference lands on the order created up front', () => {
    const { context } = testContext();
    const id = preference(context);
    const order = created(createMerchantOrder(context, { preference_id: id }));

    attachPayment(context, id, 1_000_000_001, 'approved', 20.5);
    const read = created(getMerchantOrder(context, String(order['id'])));
    expect(read['order_status']).toBe('paid');
    expect(read['paid_amount']).toBe(20.5);
  });

  test('rejects an unknown preference and a malformed body', () => {
    const { context } = testContext();
    expect(failure(createMerchantOrder(context, { preference_id: 'nope' })).status).toBe(400);
    expect(failure(createMerchantOrder(context, 'not an object')).status).toBe(400);
    expect(failure(createMerchantOrder(context, { site_id: 'MLZ' })).status).toBe(400);
    expect(failure(createMerchantOrder(context, { notification_url: 'ftp://x' })).status).toBe(400);
    expect(failure(createMerchantOrder(context, { sponsor_id: 1.5 })).status).toBe(400);
    expect(failure(createMerchantOrder(context, {})).status).toBe(400);
    expect(failure(createMerchantOrder(context, { items: [] })).status).toBe(400);
    expect(failure(createMerchantOrder(context, { items: [{ unit_price: 0 }] })).status).toBe(400);
    expect(failure(createMerchantOrder(context, { items: [{ unit_price: -1 }] })).status).toBe(400);
    expect(failure(createMerchantOrder(context, { items: [{ unit_price: 1, quantity: 0 }] })).status).toBe(400);
    expect(failure(createMerchantOrder(context, { items: [{ unit_price: 0.001 }] })).status).toBe(400);
    expect(failure(createMerchantOrder(context, { items: {} })).status).toBe(400);
    expect(failure(createMerchantOrder(context, { items: ITEMS, shipments: [{ cost: 'free' }] })).status).toBe(400);
  });

  test('attaches the payments given on creation and derives the status from them', () => {
    const { context } = testContext();
    const paymentId = approvedPayment(context, 30);
    const order = created(createMerchantOrder(context, { items: ITEMS, payments: [{ id: paymentId }] }));

    expect(order['payments']).toHaveLength(1);
    expect(order['paid_amount']).toBe(30);
    expect(order['order_status']).toBe('paid');
    expect(order['status']).toBe('closed');
    expect(failure(createMerchantOrder(context, { items: ITEMS, payments: [{ id: 7 }] })).status).toBe(400);
  });

  test('merges repeated references to the same payment instead of double counting', () => {
    const { context } = testContext();
    const paymentId = approvedPayment(context, 30);
    const order = created(
      createMerchantOrder(context, { items: ITEMS, payments: [{ id: paymentId }, paymentId] }),
    );

    expect(order['payments']).toHaveLength(1);
    expect(order['paid_amount']).toBe(30);
  });

  test('counts what the payment captured, not what it authorized', () => {
    const { context } = testContext();
    const token = unwrap(createCardToken(context, cardTokenBody({ cardholder: { name: 'APRO' } })))
      .body as { id?: string };
    const authorized = unwrap(
      createPayment(context, cardPaymentBody(token.id ?? '', { transaction_amount: 30, capture: false })),
    ).body as { id: number };
    unwrap(updatePayment(context, String(authorized.id), { capture: true, transaction_amount: 10 }));

    const order = created(
      createMerchantOrder(context, { items: ITEMS, payments: [{ id: authorized.id }] }),
    );
    expect(order['paid_amount']).toBe(10);
    expect(order['order_status']).toBe('partially_paid');
  });

  test('an order on an already expired preference is born expired', () => {
    const { context, clock } = testContext();
    const id = preference(context, {
      expires: true,
      expiration_date_to: new Date(clock.now() + 1_000).toISOString(),
    });
    clock.advance(2_000);

    const order = created(createMerchantOrder(context, { preference_id: id }));
    expect(order['order_status']).toBe('expired');
    expect(order['status']).toBe('expired');
    expect(created(searchMerchantOrders(context, new URLSearchParams('status=expired')))['total']).toBe(1);
  });

  test('resets marketplace and additional_info when they are sent as null', () => {
    const { context } = testContext();
    const order = created(
      createMerchantOrder(context, {
        items: ITEMS,
        marketplace: null,
        additional_info: null,
        application_id: 12345,
      }),
    );
    expect(order['marketplace']).toBe('NONE');
    expect(order['additional_info']).toBe('');
    expect(order['application_id']).toBe(12345);
  });
});

describe('updateMerchantOrder', () => {
  test('replaces the items and recomputes the total', () => {
    const { context } = testContext();
    const order = created(createMerchantOrder(context, { items: ITEMS }));

    const updated = created(
      updateMerchantOrder(context, String(order['id']), {
        items: [{ title: 'Tea', quantity: 3, unit_price: 5 }],
        shipments: [{ cost: 2 }],
        additional_info: 'changed',
        external_reference: 'ORDER-9',
      }),
    );

    expect(updated['total_amount']).toBe(15);
    expect(updated['shipping_cost']).toBe(2);
    expect(updated['additional_info']).toBe('changed');
    expect(updated['order_status']).toBe('payment_required');
    expect(created(searchMerchantOrders(context, new URLSearchParams('external_reference=ORDER-9')))['total']).toBe(1);
  });

  test('leaves untouched fields alone', () => {
    const { context } = testContext();
    const order = created(createMerchantOrder(context, { items: ITEMS, marketplace: 'NONE' }));
    const updated = created(updateMerchantOrder(context, String(order['id']), { marketplace: 'MP-MKT' }));

    expect(updated['marketplace']).toBe('MP-MKT');
    expect(updated['total_amount']).toBe(30);
    expect(updated['items']).toHaveLength(2);
  });

  test('attaches a payment and derives paid_amount and order_status from it', () => {
    const { context } = testContext();
    const order = created(createMerchantOrder(context, { items: ITEMS }));
    const paymentId = approvedPayment(context, 10);

    let updated = created(updateMerchantOrder(context, String(order['id']), { payments: [{ id: paymentId }] }));
    expect(updated['paid_amount']).toBe(10);
    expect(updated['order_status']).toBe('partially_paid');
    expect(updated['payments']).toHaveLength(1);

    // Re-attaching the same payment refreshes it in place instead of double counting.
    updated = created(updateMerchantOrder(context, String(order['id']), { payments: [{ id: paymentId }] }));
    expect(updated['payments']).toHaveLength(1);
    expect(updated['paid_amount']).toBe(10);

    const second = approvedPayment(context, 20);
    updated = created(updateMerchantOrder(context, String(order['id']), { payments: [second] }));
    expect(updated['paid_amount']).toBe(30);
    expect(updated['order_status']).toBe('paid');
    expect(updated['status']).toBe('closed');
  });

  test('a shrinking cart turns an outstanding order into a paid one', () => {
    const { context } = testContext();
    const order = created(createMerchantOrder(context, { items: ITEMS }));
    const paymentId = approvedPayment(context, 10);
    updateMerchantOrder(context, String(order['id']), { payments: [{ id: paymentId }] });

    const updated = created(
      updateMerchantOrder(context, String(order['id']), { items: [{ title: 'Tea', unit_price: 10 }] }),
    );
    expect(updated['total_amount']).toBe(10);
    expect(updated['order_status']).toBe('paid');
  });

  test('keeps a preference-owned order consistent with its preference', () => {
    const { context } = testContext();
    const id = preference(context);
    const order = created(createMerchantOrder(context, { preference_id: id }));

    expect(failure(updateMerchantOrder(context, String(order['id']), { items: ITEMS })).status).toBe(400);
    expect(failure(updateMerchantOrder(context, String(order['id']), { shipments: [] })).status).toBe(400);
    expect(failure(updateMerchantOrder(context, String(order['id']), { preference_id: 'other' })).status).toBe(400);

    const updated = created(updateMerchantOrder(context, String(order['id']), { additional_info: 'ok' }));
    expect(updated['additional_info']).toBe('ok');
    expect(updated['total_amount']).toBe(20.5);
  });

  test('reflects a refund taken on the payment itself when it is re-attached', () => {
    const { context } = testContext();
    const order = created(createMerchantOrder(context, { items: ITEMS }));
    const paymentId = approvedPayment(context, 30);
    const reference = { payments: [{ id: paymentId }] };
    expect(created(updateMerchantOrder(context, String(order['id']), reference))['order_status']).toBe('paid');

    unwrap(createRefund(context, String(paymentId), { amount: 10 }));
    let updated = created(updateMerchantOrder(context, String(order['id']), reference));
    expect(updated['refunded_amount']).toBe(10);
    expect(updated['order_status']).toBe('partially_refunded');

    unwrap(createRefund(context, String(paymentId), {}));
    updated = created(updateMerchantOrder(context, String(order['id']), reference));
    expect(updated['refunded_amount']).toBe(30);
    expect(updated['order_status']).toBe('refunded');
  });

  test('reports 404 for an unknown order and 400 for an unknown payment', () => {
    const { context } = testContext();
    expect(failure(updateMerchantOrder(context, '2000000009', {})).status).toBe(404);
    expect(failure(updateMerchantOrder(context, 'abc', {})).status).toBe(404);

    const order = created(createMerchantOrder(context, { items: ITEMS }));
    expect(failure(updateMerchantOrder(context, String(order['id']), { payments: [{ id: 7 }] })).status).toBe(400);
    expect(failure(updateMerchantOrder(context, String(order['id']), { payments: 'x' })).status).toBe(400);
    expect(failure(updateMerchantOrder(context, String(order['id']), 'x')).status).toBe(400);
  });
});
