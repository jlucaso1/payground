import { describe, expect, test } from 'bun:test';
import { isErr, unwrap } from '../result.ts';
import { create } from './create.ts';
import { CARD, amount, input } from './fixture.ts';

const now = 1_000;

describe('create', () => {
  test('a Pix payment starts pending and unsettled', () => {
    const p = unwrap(create(input(), { kind: 'pending', reason: 'awaiting_payer' }, now));
    expect(p.status).toEqual({ state: 'pending', reason: 'awaiting_payer' });
    expect(Number(p.capturedAmount)).toBe(0);
    expect(p.settledAt).toBeNull();
    expect(p.createdAt).toBe(now);
  });

  test('an authorized card holds the amount without capturing it', () => {
    const p = unwrap(create(input({ method: CARD }), { kind: 'authorize' }, now));
    expect(p.status).toEqual({ state: 'authorized', reason: 'awaiting_capture' });
    expect(Number(p.capturedAmount)).toBe(0);
  });

  test('a settled payment captures the full amount immediately', () => {
    const p = unwrap(create(input({ method: CARD }), { kind: 'settle' }, now));
    expect(Number(p.capturedAmount)).toBe(p.amount);
    expect(p.settledAt).toBe(now);
  });

  test('a decline carries its reason', () => {
    const p = unwrap(create(input(), { kind: 'decline', reason: 'insufficient_funds' }, now));
    expect(p.status).toEqual({ state: 'failed', reason: 'insufficient_funds' });
  });

  test('rejects a non-positive amount', () => {
    expect(isErr(create(input({ amount: amount(0) }), { kind: 'settle' }, now))).toBe(true);
  });

  test('rejects installments below one or fractional', () => {
    expect(isErr(create(input({ installments: 0 }), { kind: 'settle' }, now))).toBe(true);
    expect(isErr(create(input({ installments: 1.5 }), { kind: 'settle' }, now))).toBe(true);
  });

  test('rejects an expiry that has already passed', () => {
    expect(isErr(create(input({ expiresAt: now }), { kind: 'settle' }, now))).toBe(true);
    expect(isErr(create(input({ expiresAt: now + 1 }), { kind: 'settle' }, now))).toBe(false);
  });

  test('binary mode forbids a payment that would sit in review or pending', () => {
    const binary = input({ binaryMode: true });
    expect(isErr(create(binary, { kind: 'review', reason: 'manual_review' }, now))).toBe(true);
    expect(isErr(create(binary, { kind: 'pending', reason: 'awaiting_payer' }, now))).toBe(true);
    expect(isErr(create(binary, { kind: 'settle' }, now))).toBe(false);
    expect(isErr(create(binary, { kind: 'decline', reason: 'other' }, now))).toBe(false);
  });
});
