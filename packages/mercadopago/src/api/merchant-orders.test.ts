import { describe, expect, test } from 'bun:test';
import { type JsonObject, isJsonObject } from '@payground/core';
import { testContext } from '../testing.ts';
import type { ServiceContext } from './context.ts';
import {
  attachPayment,
  getMerchantOrder,
  orderForPreference,
  orderStatusOf,
  searchMerchantOrders,
} from './merchant-orders.ts';
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
