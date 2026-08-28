import { describe, expect, test } from 'bun:test';
import { isErr, unwrap } from '../result.ts';
import { apply, refundable } from './payment.ts';
import { CARD, amount, payment } from './fixture.ts';

const later = 5_000;

describe('apply', () => {
  test('rejects a command the current state does not allow', () => {
    const settled = payment({ kind: 'settle' });
    const result = apply(settled, { type: 'capture', amount: null }, later);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'invalid_transition', from: settled.status, command: 'capture' },
    });
  });

  test('settling a pending payment captures the full amount', () => {
    const t = unwrap(apply(payment(), { type: 'settle' }, later));
    expect(t.to).toEqual({ state: 'succeeded', reason: 'settled' });
    expect(Number(t.payment.capturedAmount)).toBe(Number(t.payment.amount));
    expect(t.payment.settledAt).toBe(later);
    expect(t.payment.updatedAt).toBe(later);
    expect(t.from).toEqual({ state: 'pending', reason: 'awaiting_payer' });
  });

  test('expiry only fires once the deadline has passed', () => {
    const p = payment({ kind: 'pending', reason: 'awaiting_payer' }, { expiresAt: 4_000 });
    expect(isErr(apply(p, { type: 'expire' }, 3_999))).toBe(true);
    const t = unwrap(apply(p, { type: 'expire' }, 4_000));
    expect(t.to).toEqual({ state: 'cancelled', reason: 'expired' });
  });

  test('a payment with no deadline never expires', () => {
    expect(isErr(apply(payment(), { type: 'expire' }, Number.MAX_SAFE_INTEGER))).toBe(true);
  });

  test('cancellation records who cancelled', () => {
    expect(unwrap(apply(payment(), { type: 'cancel', by: 'payer' }, later)).to).toEqual({
      state: 'cancelled',
      reason: 'by_payer',
    });
    expect(unwrap(apply(payment(), { type: 'cancel', by: 'collector' }, later)).to).toEqual({
      state: 'cancelled',
      reason: 'by_collector',
    });
  });

  describe('capture', () => {
    const authorized = payment({ kind: 'authorize' }, { method: CARD });

    test('captures the full amount by default', () => {
      const t = unwrap(apply(authorized, { type: 'capture', amount: null }, later));
      expect(Number(t.payment.capturedAmount)).toBe(Number(authorized.amount));
    });

    test('captures less than authorized', () => {
      const t = unwrap(apply(authorized, { type: 'capture', amount: amount(4_000) }, later));
      expect(Number(t.payment.capturedAmount)).toBe(4_000);
      expect(t.to).toEqual({ state: 'succeeded', reason: 'settled' });
    });

    test('refuses to capture more than authorized or nothing at all', () => {
      expect(isErr(apply(authorized, { type: 'capture', amount: amount(10_001) }, later))).toBe(true);
      expect(isErr(apply(authorized, { type: 'capture', amount: amount(0) }, later))).toBe(true);
    });
  });

  describe('refund', () => {
    const settled = payment({ kind: 'settle' });

    test('a partial refund keeps the payment succeeded', () => {
      const t = unwrap(apply(settled, { type: 'refund', amount: amount(2_500) }, later));
      expect(t.to).toEqual({ state: 'succeeded', reason: 'settled' });
      expect(Number(t.payment.refundedAmount)).toBe(2_500);
      expect(Number(refundable(t.payment))).toBe(7_500);
    });

    test('refunding the remainder moves the payment to refunded', () => {
      const first = unwrap(apply(settled, { type: 'refund', amount: amount(6_000) }, later)).payment;
      const second = unwrap(apply(first, { type: 'refund', amount: amount(4_000) }, later + 1));
      expect(second.to).toEqual({ state: 'refunded', reason: 'refunded' });
      expect(Number(refundable(second.payment))).toBe(0);
    });

    test('never refunds more than remains', () => {
      expect(isErr(apply(settled, { type: 'refund', amount: amount(10_001) }, later))).toBe(true);
      const partial = unwrap(apply(settled, { type: 'refund', amount: amount(9_000) }, later)).payment;
      expect(isErr(apply(partial, { type: 'refund', amount: amount(1_001) }, later))).toBe(true);
    });

    test('only refunds what was actually captured', () => {
      const authorized = payment({ kind: 'authorize' }, { method: CARD });
      const captured = unwrap(apply(authorized, { type: 'capture', amount: amount(3_000) }, later)).payment;
      expect(Number(refundable(captured))).toBe(3_000);
      expect(isErr(apply(captured, { type: 'refund', amount: amount(3_001) }, later))).toBe(true);
    });
  });

  describe('dispute', () => {
    const settled = payment({ kind: 'settle' });

    test('a chargeback resolution lands on charged_back', () => {
      const disputed = unwrap(apply(settled, { type: 'dispute' }, later)).payment;
      expect(disputed.status).toEqual({ state: 'in_mediation', reason: 'disputed' });
      const resolved = unwrap(apply(disputed, { type: 'resolve', outcome: 'chargeback' }, later + 1));
      expect(resolved.to).toEqual({ state: 'charged_back', reason: 'settled' });
    });

    test('a merchant win returns the payment to succeeded', () => {
      const disputed = unwrap(apply(settled, { type: 'dispute' }, later)).payment;
      const resolved = unwrap(apply(disputed, { type: 'resolve', outcome: 'merchant' }, later + 1));
      expect(resolved.to).toEqual({ state: 'succeeded', reason: 'settled' });
    });
  });

  test('binary mode payments cannot be pushed into review', () => {
    const p = payment({ kind: 'pending', reason: 'awaiting_payer' }, { binaryMode: false });
    expect(isErr(apply({ ...p, binaryMode: true }, { type: 'review', reason: 'contingency' }, later))).toBe(true);
    expect(isErr(apply(p, { type: 'review', reason: 'contingency' }, later))).toBe(false);
  });

  test('the original payment is never mutated', () => {
    const p = payment();
    const snapshot = structuredClone(p);
    unwrap(apply(p, { type: 'settle' }, later));
    expect(p).toEqual(snapshot);
  });
});
