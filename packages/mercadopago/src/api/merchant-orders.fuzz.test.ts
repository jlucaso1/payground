import { expect, test } from 'bun:test';
import { type JsonObject, type Result, fromDecimal, isJsonObject, unwrap } from '@payground/core';
import { SeededRandom } from '@payground/core/testing.ts';
import type { ErrorBody } from '../errors.ts';
import { createCardToken } from './card-tokens.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { cardPaymentBody, cardTokenBody, harness } from './fixture.ts';
import { createMerchantOrder, getMerchantOrder, orderStatusOf, updateMerchantOrder } from './merchant-orders.ts';
import { createPayment, createRefund } from './payments.ts';

const body = (result: Result<Rendered, ErrorBody>): JsonObject => {
  const rendered = unwrap(result).body;
  if (!isJsonObject(rendered)) throw new Error('expected a Json object');
  return rendered;
};

const objects = (doc: JsonObject, key: string): JsonObject[] =>
  (Array.isArray(doc[key]) ? doc[key] : []).filter((entry): entry is JsonObject => isJsonObject(entry));

const toMinor = (value: unknown): number => {
  const parsed = fromDecimal(typeof value === 'number' ? value : 0);
  if (!parsed.ok) throw new Error(`not a wire amount: ${String(value)}`);
  return parsed.value;
};

const APPROVED: readonly string[] = ['approved'];
const REFUNDED: readonly string[] = ['refunded', 'charged_back'];

/** Recomputes every derived field from the items, the shipments and the attached payments. */
function check(doc: JsonObject): void {
  const total = objects(doc, 'items').reduce(
    (sum, item) => sum + toMinor(item['unit_price']) * (typeof item['quantity'] === 'number' ? item['quantity'] : 0),
    0,
  );
  const shipping = objects(doc, 'shipments').reduce((sum, entry) => sum + toMinor(entry['cost']), 0);

  let paid = 0;
  let refunded = 0;
  for (const payment of objects(doc, 'payments')) {
    const status = typeof payment['status'] === 'string' ? payment['status'] : '';
    const amount = toMinor(payment['total_paid_amount']);
    if (APPROVED.includes(status) || REFUNDED.includes(status)) paid += amount;
    refunded += toMinor(payment['amount_refunded']);
  }

  const expected = orderStatusOf({ dueMinor: total + shipping, paidMinor: paid, refundedMinor: refunded, expired: false });
  expect({
    total: toMinor(doc['total_amount']),
    shipping: toMinor(doc['shipping_cost']),
    paid: toMinor(doc['paid_amount']),
    refunded: toMinor(doc['refunded_amount']),
    order_status: doc['order_status'],
    status: doc['status'],
  }).toEqual({
    total,
    shipping,
    paid,
    refunded,
    order_status: expected,
    status: expected === 'expired' ? 'expired' : expected === 'paid' ? 'closed' : 'opened',
  });
}

const CODES: readonly string[] = ['APRO', 'OTHE', 'CONT'];

function payment(context: ServiceContext, random: SeededRandom): number {
  const code = CODES[random.int(CODES.length)] ?? 'APRO';
  const token = unwrap(createCardToken(context, cardTokenBody({ cardholder: { name: code } }))).body as {
    id?: string;
  };
  const amount = (1 + random.int(4000)) / 100;
  const created = body(createPayment(context, cardPaymentBody(token.id ?? '', { transaction_amount: amount })));
  return typeof created['id'] === 'number' ? created['id'] : Number(created['id']);
}

const items = (random: SeededRandom): JsonObject[] =>
  Array.from({ length: 1 + random.int(3) }, (_, index) => ({
    id: `sku-${index}`,
    title: `Item ${index}`,
    quantity: 1 + random.int(3),
    unit_price: (1 + random.int(5000)) / 100,
  }));

test('merchant order totals and derived status survive a seeded sweep of updates', () => {
  const random = new SeededRandom(20_240_912);
  const app = harness();
  const attached: number[] = [];

  const order = body(createMerchantOrder(app.context, { items: items(random) }));
  const id = String(order['id']);
  check(order);

  for (let round = 0; round < 300; round++) {
    app.clock.advance(1_000);

    switch (random.int(5)) {
      case 0:
        check(body(updateMerchantOrder(app.context, id, { items: items(random) })));
        break;
      case 1:
        check(
          body(
            updateMerchantOrder(app.context, id, {
              shipments: Array.from({ length: random.int(3) }, () => ({ cost: random.int(2000) / 100 })),
            }),
          ),
        );
        break;
      case 2: {
        const sequence = payment(app.context, random);
        attached.push(sequence);
        check(body(updateMerchantOrder(app.context, id, { payments: [{ id: sequence }] })));
        break;
      }
      case 3: {
        // Refunding behind the order's back must still show up on the next update.
        const sequence = attached[random.int(Math.max(attached.length, 1))];
        if (sequence === undefined) break;
        createRefund(app.context, String(sequence), random.int(2) === 0 ? {} : { amount: 0.5 });
        check(body(updateMerchantOrder(app.context, id, { payments: [{ id: sequence }] })));
        break;
      }
      default:
        check(body(updateMerchantOrder(app.context, id, { additional_info: `round ${round}` })));
        break;
    }

    check(body(getMerchantOrder(app.context, id)));
  }

  const final = body(getMerchantOrder(app.context, id));
  expect(objects(final, 'payments').length).toBe(new Set(attached).size);

  // The sweep is only meaningful if it reached the interesting statuses.
  const statuses = new Set(objects(final, 'payments').map((entry) => entry['status']));
  expect([...statuses].sort()).toEqual(['approved', 'in_process', 'refunded', 'rejected']);
});
