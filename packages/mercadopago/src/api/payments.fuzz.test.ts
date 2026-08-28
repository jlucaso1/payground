import { expect, test } from 'bun:test';
import { type Result, unwrap } from '@payground/core';
import { SeededRandom } from '@payground/core/testing.ts';
import type { ErrorBody } from '../errors.ts';
import type { CardToken, Payment as PaymentResource } from '../generated/types.ts';
import { brandFromBin, codesForBrand, createCardToken, getCardToken, luhn } from './card-tokens.ts';
import type { Rendered } from './context.ts';
import { CARDHOLDER_DECISIONS } from './decision.ts';
import { cardPaymentBody, cardTokenBody, harness } from './fixture.ts';
import { createPayment, getPayment, updatePayment } from './payments.ts';

const CODES = Object.keys(CARDHOLDER_DECISIONS);
const PREFIXES: readonly [string, number][] = [
  ['4', 16],
  ['51', 16],
  ['37', 15],
  ['5067', 16],
  ['606282', 16],
];

const pick = <T>(random: SeededRandom, values: readonly T[]): T => {
  const value = values[random.int(values.length)];
  if (value === undefined) throw new Error('empty pool');
  return value;
};

/** Builds a Luhn valid number for a prefix, so the fuzzer exercises real acceptance. */
function cardNumber(random: SeededRandom, prefix: string, length: number): string {
  let body = prefix;
  while (body.length < length - 1) body += String(random.int(10));
  for (let check = 0; check < 10; check++) {
    const candidate = `${body}${check}`;
    if (luhn(candidate)) return candidate;
  }
  throw new Error('no check digit');
}

const failed = (result: Result<Rendered, ErrorBody>): ErrorBody => {
  if (result.ok) throw new Error('expected a failure');
  return result.error;
};

test('card payments hold their invariants across a seeded sweep', () => {
  const random = new SeededRandom(20_240_601);
  const seen = new Set<string>();

  for (let round = 0; round < 400; round++) {
    const app = harness(1_700_000_000_000 + round * 1_000);
    const [prefix, length] = pick(random, PREFIXES);
    const number = cardNumber(random, prefix, length);
    const brand = brandFromBin(number.slice(0, 6));
    expect(brand).not.toBeNull();
    if (brand === null) continue;

    const code = pick(random, CODES);
    const installments = 1 + random.int(24);
    const capture = random.int(2) === 0;
    const securityCode = brand === 'amex' ? '1234' : '123';

    const token = unwrap(
      createCardToken(
        app.context,
        cardTokenBody({ card_number: number, security_code: securityCode, cardholder: { name: code } }),
      ),
    ).body as CardToken;
    const tokenId = token.id ?? '';

    // The token never carries the full number, and the id is opaque.
    expect(JSON.stringify(token)).not.toContain(number);
    expect(tokenId).toMatch(/^[0-9a-f]{32}$/);

    const created = createPayment(
      app.context,
      cardPaymentBody(tokenId, { installments, capture }),
    );
    const payment = unwrap(created).body as PaymentResource;
    seen.add(`${payment.status}/${payment.status_detail}`);

    // The catalogue code always follows the bin, and the payment never leaks the number.
    expect(payment.payment_method_id).toBe(codesForBrand(brand, false).preferred);
    expect(payment.installments).toBe(installments);
    expect(JSON.stringify(payment)).not.toContain(number);
    expect(payment.card?.last_four_digits).toBe(number.slice(-4));

    // The decision table drives the outcome, and capture=false only defers a settlement.
    const decision = CARDHOLDER_DECISIONS[code];
    const expected =
      decision?.kind === 'settle' ? (capture ? 'approved' : 'authorized') : null;
    if (expected !== null) expect(payment.status).toBe(expected);
    expect(payment.captured).toBe(payment.status === 'approved');

    // The token is burnt exactly once, whatever the outcome was.
    expect((unwrap(getCardToken(app.context, tokenId)).body as CardToken).status).toBe('used');
    expect(failed(createPayment(app.context, cardPaymentBody(tokenId))).status).toBe(400);

    if (payment.status === 'authorized') {
      const partial = Math.max(1, Math.round(random.int(10_050)) / 100);
      const captured = unwrap(
        updatePayment(app.context, String(payment.id), { capture: true, transaction_amount: partial }),
      ).body as PaymentResource;
      expect(captured.status).toBe('approved');
      expect(captured.transaction_amount).toBe(100.5);
      expect(captured.transaction_details?.total_paid_amount).toBe(partial);
      // A captured payment cannot be captured again.
      expect(failed(updatePayment(app.context, String(payment.id), { capture: true })).status).toBe(422);
    }

    // Reads are stable.
    const read = unwrap(getPayment(app.context, String(payment.id))).body as PaymentResource;
    expect(read.status_detail).toBe(
      payment.status === 'authorized' ? 'accredited' : (payment.status_detail as string),
    );
  }

  // The sweep must have reached settlement, authorisation, review and rejection.
  expect(seen.size).toBeGreaterThan(3);
});

test('tokenisation rejects everything that is neither a test card nor Luhn valid', () => {
  const random = new SeededRandom(7);
  for (let round = 0; round < 300; round++) {
    const app = harness();
    let number = '';
    const length = 13 + random.int(7);
    while (number.length < length) number += String(random.int(10));

    const brand = brandFromBin(number.slice(0, 6));
    const result = createCardToken(app.context, cardTokenBody({ card_number: number }));
    // The fixture sends a three digit security code, which amex refuses.
    const valid = luhn(number) && brand !== null && brand !== 'amex';
    expect(result.ok).toBe(valid);
    if (!result.ok) expect(result.error.status).toBe(400);
  }
});
