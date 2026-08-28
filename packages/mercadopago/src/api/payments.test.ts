import { describe, expect, test } from 'bun:test';
import { type Result, unwrap } from '@payground/core';
import type { ErrorBody } from '../errors.ts';
import type { Payment as PaymentResource } from '../generated/types.ts';
import { createCardToken } from './card-tokens.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { CARDHOLDER_DECISIONS } from './decision.ts';
import { type Harness, cardPaymentBody, cardTokenBody, harness } from './fixture.ts';
import { createPayment, getPayment, updatePayment } from './payments.ts';

const paid = (result: Result<Rendered, ErrorBody>): PaymentResource =>
  unwrap(result).body as PaymentResource;

function tokenFor(context: ServiceContext, overrides: Record<string, unknown> = {}): string {
  const token = unwrap(createCardToken(context, cardTokenBody(overrides))).body as { id?: string };
  return token.id ?? '';
}

function pay(app: Harness, overrides: Record<string, unknown> = {}, card: Record<string, unknown> = {}) {
  const token = tokenFor(app.context, card);
  return createPayment(app.context, cardPaymentBody(token, overrides));
}

/** Every documented cardholder code, end to end: token, payment, provider status. */
const OUTCOMES: readonly [string, string, string][] = [
  ['APRO', 'approved', 'accredited'],
  ['OTHE', 'rejected', 'cc_rejected_other_reason'],
  ['CONT', 'in_process', 'pending_contingency'],
  ['CALL', 'rejected', 'cc_rejected_call_for_authorize'],
  ['FUND', 'rejected', 'cc_rejected_insufficient_amount'],
  ['SECU', 'rejected', 'cc_rejected_bad_filled_security_code'],
  ['EXPI', 'rejected', 'cc_rejected_bad_filled_date'],
  ['FORM', 'rejected', 'cc_rejected_bad_filled_other'],
  ['CARD', 'rejected', 'cc_rejected_bad_filled_card_number'],
  ['INST', 'rejected', 'cc_rejected_invalid_installments'],
  ['DUPL', 'rejected', 'cc_rejected_duplicated_payment'],
  ['LOCK', 'rejected', 'cc_rejected_card_disabled'],
  ['CTNA', 'rejected', 'cc_rejected_card_type_not_allowed'],
  ['ATTE', 'rejected', 'cc_rejected_max_attempts'],
  ['BLAC', 'rejected', 'cc_rejected_blacklist'],
  ['UNSU', 'rejected', 'cc_rejected_other_reason'],
  ['TEST', 'approved', 'accredited'],
];

describe('card payments', () => {
  test('the outcome table covers every documented cardholder code', () => {
    expect(OUTCOMES.map(([code]) => code).sort()).toEqual(Object.keys(CARDHOLDER_DECISIONS).sort());
  });

  for (const [code, status, detail] of OUTCOMES) {
    test(`cardholder ${code} settles as ${status}/${detail}`, () => {
      const app = harness();
      const created = paid(pay(app, {}, { cardholder: { name: code } }));

      expect(created).toMatchObject({ status, status_detail: detail, payment_method_id: 'visa' });
      const read = paid(getPayment(app.context, String(created.id)));
      expect(read).toMatchObject({ status, status_detail: detail });
    });
  }

  test('carries the card snapshot and never the PAN', () => {
    const app = harness();
    const created = paid(pay(app));
    expect(created.card).toMatchObject({
      first_six_digits: '423564',
      last_four_digits: '5682',
      expiration_month: 11,
      expiration_year: 2030,
      cardholder: { name: 'APRO' },
    });
    expect(JSON.stringify(created)).not.toContain('4235647728025682');
    expect(created.payment_type_id).toBe('credit_card');
  });

  test('a token is single use across payments', () => {
    const app = harness();
    const token = tokenFor(app.context);
    expect(createPayment(app.context, cardPaymentBody(token)).ok).toBe(true);

    const reuse = createPayment(app.context, cardPaymentBody(token));
    expect(reuse.ok).toBe(false);
    if (!reuse.ok) {
      expect(reuse.error.status).toBe(400);
      expect(JSON.stringify(reuse.error.cause)).toContain('already used');
    }
  });

  test('an unknown token is refused in the provider envelope', () => {
    const app = harness();
    const result = createPayment(app.context, cardPaymentBody('deadbeef'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error.cause)).toContain('not found');
  });

  test('an expired token is refused', () => {
    const app = harness();
    const token = tokenFor(app.context);
    app.clock.advance(7 * 24 * 60 * 60 * 1000);
    const result = createPayment(app.context, cardPaymentBody(token));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error.cause)).toContain('expired');
  });

  test('a card payment without a token is refused', () => {
    const app = harness();
    const result = createPayment(app.context, {
      transaction_amount: 10,
      payment_method_id: 'visa',
      payer: { email: 'payer@example.com' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error.cause)).toContain('require a token');
  });
});

describe('payment_method_id and the card brand', () => {
  test('is derived from the bin when the caller omits it', () => {
    const app = harness();
    expect(paid(pay(app)).payment_method_id).toBe('visa');

    const amex = paid(
      pay(app, {}, { card_number: '3753 651535 56885', security_code: '1234' }),
    );
    expect(amex.payment_method_id).toBe('amex');
  });

  test('a documented debit test card defaults to the debit code', () => {
    const app = harness();
    const elo = paid(pay(app, {}, { card_number: '5067 7667 8388 8311' }));
    expect(elo).toMatchObject({ payment_method_id: 'debelo', payment_type_id: 'debit_card' });
  });

  test('an explicit code that matches the brand is honoured', () => {
    const app = harness();
    expect(paid(pay(app, { payment_method_id: 'debvisa' })).payment_method_id).toBe('debvisa');
  });

  test('a code that disagrees with the brand is refused', () => {
    const app = harness();
    for (const code of ['master', 'pix']) {
      const result = pay(app, { payment_method_id: code });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(JSON.stringify(result.error.cause)).toContain('does not match the card brand');
    }
  });

  test('an unknown code is still refused before anything else', () => {
    const app = harness();
    const result = pay(app, { payment_method_id: 'unknown_method' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error.cause)).toContain('payment_method_id invalid');
  });
});

describe('installments', () => {
  test('are accepted between 1 and 24', () => {
    for (const installments of [1, 12, 24]) {
      const app = harness();
      const created = paid(pay(app, { installments }));
      expect(created.installments).toBe(installments);
      expect(created.transaction_details?.installment_amount).toBeCloseTo(100.5 / installments, 6);
    }
  });

  test('are refused outside the bounds', () => {
    // 0, negatives and non-integers are already caught by the generated schema check.
    for (const installments of [0, -1, 25, 1.5]) {
      const app = harness();
      const result = pay(app, { installments });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.status).toBe(400);
        expect(JSON.stringify(result.error.cause)).toContain('installments');
      }
    }
    const app = harness();
    const above = pay(app, { installments: 25 });
    if (!above.ok) expect(JSON.stringify(above.error.cause)).toContain('between 1 and 24');
  });
});

describe('capture', () => {
  test('capture false authorizes instead of settling', () => {
    const app = harness();
    const created = paid(pay(app, { capture: false }));
    expect(created).toMatchObject({ status: 'authorized', status_detail: 'pending_capture', captured: false });
  });

  test('a full capture settles the authorized amount', () => {
    const app = harness();
    const created = paid(pay(app, { capture: false }));
    const captured = paid(updatePayment(app.context, String(created.id), { capture: true }));

    expect(captured).toMatchObject({ status: 'approved', status_detail: 'accredited', captured: true });
    expect(captured.transaction_details?.total_paid_amount).toBe(100.5);
    expect(captured.transaction_amount).toBe(100.5);
  });

  test('a partial capture settles only what was asked for', () => {
    const app = harness();
    const created = paid(pay(app, { capture: false }));
    const captured = paid(
      updatePayment(app.context, String(created.id), { capture: true, transaction_amount: 40.25 }),
    );

    expect(captured).toMatchObject({ status: 'approved', captured: true, transaction_amount: 100.5 });
    expect(captured.transaction_details?.total_paid_amount).toBe(40.25);
    expect(captured.transaction_details?.net_received_amount).toBe(40.25);
  });

  test('a capture above the authorized amount is refused', () => {
    const app = harness();
    const created = paid(pay(app, { capture: false }));
    const result = updatePayment(app.context, String(created.id), {
      capture: true,
      transaction_amount: 200,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(422);
  });

  test('capturing twice is refused', () => {
    const app = harness();
    const created = paid(pay(app, { capture: false }));
    expect(updatePayment(app.context, String(created.id), { capture: true }).ok).toBe(true);
    expect(updatePayment(app.context, String(created.id), { capture: true }).ok).toBe(false);
  });

  test('a declined card cannot be authorized by capture false', () => {
    const app = harness();
    const created = paid(pay(app, { capture: false }, { cardholder: { name: 'FUND' } }));
    expect(created).toMatchObject({ status: 'rejected', status_detail: 'cc_rejected_insufficient_amount' });
  });

  test('binary mode turns a contingency review into a rejection', () => {
    const app = harness();
    const created = paid(pay(app, { binary_mode: true }, { cardholder: { name: 'CONT' } }));
    expect(created).toMatchObject({ status: 'rejected', status_detail: 'cc_rejected_other_reason' });
  });
});
