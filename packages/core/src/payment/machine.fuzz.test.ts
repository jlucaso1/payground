import { describe, expect, test } from 'bun:test';
import { type Minor, minor } from '../money.ts';
import { unwrap } from '../result.ts';
import { SeededRandom } from '../testing.ts';
import { CARD, PIX, input } from './fixture.ts';
import { type Payment, apply } from './payment.ts';
import { type PaymentCommand, type PaymentState, TRANSITIONS, isTerminal } from './state.ts';
import { type PaymentDecision, create } from './create.ts';

const REASONS: Record<PaymentState, readonly string[]> = {
  pending: ['awaiting_payer', 'awaiting_challenge'],
  authorized: ['awaiting_capture'],
  in_review: ['manual_review', 'contingency', 'offline'],
  succeeded: ['settled'],
  failed: [
    'insufficient_funds', 'invalid_security_code', 'expired_card', 'invalid_card_number',
    'invalid_expiry_date', 'invalid_data', 'call_for_authorize', 'card_disabled',
    'card_type_not_allowed', 'high_risk', 'duplicate', 'blacklisted', 'max_attempts',
    'invalid_installments', 'bank_error', 'timeout', 'unsupported', 'other',
  ],
  cancelled: ['expired', 'by_collector', 'by_payer'],
  refunded: ['refunded'],
  in_mediation: ['disputed'],
  charged_back: ['in_process', 'settled', 'reimbursed'],
};

const DECISIONS: PaymentDecision[] = [
  { kind: 'settle' },
  { kind: 'authorize' },
  { kind: 'pending', reason: 'awaiting_payer' },
  { kind: 'pending', reason: 'awaiting_challenge' },
  { kind: 'review', reason: 'manual_review' },
  { kind: 'decline', reason: 'other' },
];

function randomCommand(rng: SeededRandom, p: Payment): PaymentCommand {
  const cents = (n: number): Minor => unwrap(minor(n));
  const options: PaymentCommand[] = [
    { type: 'settle' },
    { type: 'review', reason: 'contingency' },
    { type: 'decline', reason: 'high_risk' },
    { type: 'expire' },
    { type: 'cancel', by: rng.int(2) === 0 ? 'payer' : 'collector' },
    { type: 'capture', amount: rng.int(2) === 0 ? null : cents(rng.int(p.amount + 2_000)) },
    { type: 'refund', amount: cents(rng.int(p.amount + 2_000)) },
    { type: 'dispute' },
    { type: 'resolve', outcome: rng.int(2) === 0 ? 'chargeback' : 'merchant' },
  ];
  return options[rng.int(options.length)] as PaymentCommand;
}

function invariants(p: Payment): void {
  expect(TRANSITIONS).toHaveProperty(p.status.state);
  expect(REASONS[p.status.state]).toContain(p.status.reason);
  expect(p.amount).toBeGreaterThan(0);
  expect(p.capturedAmount).toBeGreaterThanOrEqual(0);
  expect(p.capturedAmount).toBeLessThanOrEqual(p.amount);
  expect(p.refundedAmount).toBeGreaterThanOrEqual(0);
  expect(p.refundedAmount).toBeLessThanOrEqual(p.capturedAmount);
  expect(p.updatedAt).toBeGreaterThanOrEqual(p.createdAt);
  if (p.status.state === 'refunded') expect(p.refundedAmount).toBe(p.capturedAmount);
  if (p.settledAt !== null) expect(p.capturedAmount).toBeGreaterThan(0);
}

describe('state machine under random command sequences', () => {
  test('holds its invariants across 2000 walks', () => {
    const rng = new SeededRandom(2027);
    for (let walk = 0; walk < 2_000; walk++) {
      const decision = DECISIONS[rng.int(DECISIONS.length)] as PaymentDecision;
      const binaryMode = decision.kind === 'settle' || decision.kind === 'decline' ? rng.int(2) === 0 : false;
      const start = create(
        input({
          method: rng.int(2) === 0 ? PIX : CARD,
          amount: unwrap(minor(1 + rng.int(50_000))),
          binaryMode,
          expiresAt: rng.int(2) === 0 ? null : 2_000 + rng.int(10_000),
        }),
        decision,
        1_000,
      );
      expect(start.ok).toBe(true);
      if (!start.ok) continue;

      let current = start.value;
      invariants(current);
      let now = 1_000;

      for (let step = 0; step < 12; step++) {
        now += rng.int(4_000);
        const before = current;
        const result = apply(current, randomCommand(rng, current), now);
        if (result.ok) {
          expect(isTerminal(before.status.state)).toBe(false);
          current = result.value.payment;
          invariants(current);
          expect(current.updatedAt).toBe(now);
          expect(current.createdAt).toBe(before.createdAt);
          expect(current.amount).toBe(before.amount);
          expect(current.id).toBe(before.id);
        } else {
          expect(current).toEqual(before);
        }
      }
    }
  });

  test('terminal states reject every command', () => {
    const rng = new SeededRandom(5);
    const terminals: PaymentDecision[] = [{ kind: 'decline', reason: 'other' }];
    for (const decision of terminals) {
      const p = unwrap(create(input(), decision, 1_000));
      for (let i = 0; i < 200; i++) {
        expect(apply(p, randomCommand(rng, p), 2_000).ok).toBe(false);
      }
    }
  });
});
