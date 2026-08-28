import { describe, expect, test } from 'bun:test';
import { PAYMENT_STATES, type PaymentActionType, type PaymentState, type PaymentView } from '../src/api/types.ts';
import {
  PAYMENT_ACTION_TYPES,
  actionPermission,
  actionPermissions,
  capturableAmount,
  refundableAmount,
} from '../src/lib/actions.ts';

type Money = Pick<PaymentView, 'state' | 'amount' | 'capturedAmount' | 'refundedAmount'>;

const settled = (state: PaymentState): Money => ({
  state,
  amount: 10_000,
  capturedAmount: state === 'succeeded' || state === 'refunded' ? 10_000 : 0,
  refundedAmount: state === 'refunded' ? 10_000 : 0,
});

const EXPECTED: Record<PaymentState, readonly PaymentActionType[]> = {
  pending: ['settle', 'decline', 'expire', 'cancel'],
  authorized: ['decline', 'cancel', 'capture'],
  in_review: ['settle', 'decline', 'cancel'],
  succeeded: ['refund', 'dispute'],
  failed: [],
  cancelled: [],
  refunded: [],
  in_mediation: ['resolve'],
  charged_back: [],
};

describe('allowed actions per state', () => {
  test('covers all nine states', () => {
    expect(PAYMENT_STATES.length).toBe(9);
    expect(Object.keys(EXPECTED).sort()).toEqual([...PAYMENT_STATES].sort());
  });

  for (const state of PAYMENT_STATES) {
    test(state, () => {
      const allowed = actionPermissions(settled(state))
        .filter((permission) => permission.allowed)
        .map((permission) => permission.type);
      expect(allowed).toEqual([...EXPECTED[state]]);
    });
  }

  for (const state of PAYMENT_STATES) {
    test(`${state} gives a reason for every disallowed action`, () => {
      for (const permission of actionPermissions(settled(state))) {
        if (permission.allowed) {
          expect(permission.reason).toBe(null);
        } else {
          expect(typeof permission.reason).toBe('string');
          expect(permission.reason?.length ?? 0).toBeGreaterThan(0);
        }
      }
    });
  }
});

describe('amount-dependent rules', () => {
  test('refund is blocked when nothing is refundable', () => {
    const permission = actionPermission('refund', {
      state: 'succeeded',
      amount: 1000,
      capturedAmount: 1000,
      refundedAmount: 1000,
    });
    expect(permission.allowed).toBe(false);
    expect(permission.reason).toBe('Nothing left to refund');
  });

  test('refund is allowed after a partial refund', () => {
    expect(
      actionPermission('refund', {
        state: 'succeeded',
        amount: 1000,
        capturedAmount: 1000,
        refundedAmount: 400,
      }).allowed,
    ).toBe(true);
  });

  test('capture is blocked when already fully captured', () => {
    const permission = actionPermission('capture', {
      state: 'authorized',
      amount: 1000,
      capturedAmount: 1000,
      refundedAmount: 0,
    });
    expect(permission.allowed).toBe(false);
    expect(permission.reason).toBe('Already fully captured');
  });

  test('remaining amounts never go negative', () => {
    const overdrawn: Money = {
      state: 'succeeded',
      amount: 100,
      capturedAmount: 100,
      refundedAmount: 500,
    };
    expect(refundableAmount(overdrawn)).toBe(0);
    expect(capturableAmount({ amount: 100, capturedAmount: 500 })).toBe(0);
  });
});

test('every action type is covered by the permission table', () => {
  const types = actionPermissions(settled('pending')).map((p) => p.type);
  expect(types).toEqual([...PAYMENT_ACTION_TYPES]);
});
