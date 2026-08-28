import { describe, expect, test } from 'bun:test';
import type { PaymentMethod } from '@payground/core';
import { CARD, PIX } from '@payground/core/payment/fixture.ts';
import { CARDHOLDER_DECISIONS, decide } from './decision.ts';

const snapshot = CARD.card as NonNullable<PaymentMethod['card']>;
const card = (holderName: string): PaymentMethod => ({ ...CARD, card: { ...snapshot, holderName } });

describe('decision', () => {
  test('offline methods always wait for the payer', () => {
    expect(decide({ method: PIX, capture: true, binaryMode: false })).toEqual({
      kind: 'pending',
      reason: 'awaiting_payer',
    });
    expect(
      decide({ method: { kind: 'voucher', code: 'bolbradesco', card: null }, capture: true, binaryMode: false }),
    ).toEqual({ kind: 'pending', reason: 'awaiting_payer' });
  });

  test('wallet settles immediately', () => {
    expect(decide({ method: { kind: 'wallet', code: 'account_money', card: null }, capture: true, binaryMode: false })).toEqual({
      kind: 'settle',
    });
  });

  test('every documented cardholder code maps to an outcome', () => {
    const codes = Object.keys(CARDHOLDER_DECISIONS);
    expect(codes).toHaveLength(17);
    for (const code of codes) {
      expect(decide({ method: card(code), capture: true, binaryMode: false })).toEqual(
        CARDHOLDER_DECISIONS[code] as never,
      );
    }
  });

  test('matching ignores case and surrounding space', () => {
    expect(decide({ method: card('  fund '), capture: true, binaryMode: false })).toEqual({
      kind: 'decline',
      reason: 'insufficient_funds',
    });
  });

  test('an unknown cardholder is approved, like the real sandbox', () => {
    expect(decide({ method: card('JOHN DOE'), capture: true, binaryMode: false })).toEqual({ kind: 'settle' });
  });

  test('capture=false authorizes instead of settling', () => {
    expect(decide({ method: card('APRO'), capture: false, binaryMode: false })).toEqual({ kind: 'authorize' });
    expect(decide({ method: card('FUND'), capture: false, binaryMode: false })).toEqual({
      kind: 'decline',
      reason: 'insufficient_funds',
    });
  });

  test('binary mode turns a review outcome into a decline', () => {
    expect(decide({ method: card('CONT'), capture: true, binaryMode: true })).toEqual({
      kind: 'decline',
      reason: 'other',
    });
  });
});
