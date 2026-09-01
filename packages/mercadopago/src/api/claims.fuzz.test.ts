import { expect, test } from 'bun:test';
import { unwrap } from '@payground/core';
import { SeededRandom } from '@payground/core/testing.ts';
import type { Claim } from '../generated/types.ts';
import { createCardToken } from './card-tokens.ts';
import {
  CLAIM_TRANSITIONS,
  type ClaimCommand,
  type ClaimRecord,
  type ClaimState,
  applyClaim,
  claimAllowed,
  getClaim,
  openClaim,
  requestClaimMediation,
  resolveClaim,
  sendClaimMessage,
} from './claims.ts';
import { cardPaymentBody, cardTokenBody, harness } from './fixture.ts';
import { createPayment, getPayment } from './payments.ts';

const COMMANDS: readonly ClaimCommand[] = ['escalate', 'resolve', 'close', 'cancel'];
const STATES: readonly ClaimState[] = ['opened', 'dispute', 'closed', 'cancelled'];

/** The seeded LCG has weak low bits, so a power-of-two pool is drawn through a prime. */
const pick = <T>(random: SeededRandom, values: readonly T[]): T => {
  const value = values[random.int(1_009) % values.length];
  if (value === undefined) throw new Error('empty pool');
  return value;
};

const seed = (state: ClaimState): ClaimRecord => ({
  id: 1,
  state,
  type: 'claims',
  paymentId: 1,
  buyerId: 2,
  reasonId: 'PNR0001',
  createdAt: 0,
  updatedAt: 0,
  history: [],
  attachments: [],
  evidences: [],
  resolution: null,
});

test('the claim machine only ever moves along the transition table', () => {
  const random = new SeededRandom(20_240_915);
  const reached = new Set<ClaimState>();

  for (let round = 0; round < 2_000; round++) {
    let record = seed('opened');
    let now = 0;

    for (let step = 0; step < 6; step++) {
      const command = pick(random, COMMANDS);
      const before = record.state;
      now += 1 + random.int(1_000);
      const result = applyClaim(record, command, now, pick(random, ['buyer', 'seller', 'system', 'mediator'] as const));

      if (!result.ok) {
        // A refusal is a value, and it never mutates the record.
        expect(result.error).toEqual({ kind: 'invalid_transition', from: before, command });
        expect(claimAllowed(before, command)).toBe(false);
        continue;
      }

      expect(claimAllowed(before, command)).toBe(true);
      expect(STATES).toContain(result.value.state);
      expect(result.value.history).toHaveLength(record.history.length + 1);
      expect(result.value.updatedAt).toBe(now);
      // History is append-only and monotonic in time.
      expect(record.history.every((entry, index) => result.value.history[index] === entry)).toBe(true);
      record = result.value;
      reached.add(record.state);
    }

    // Terminal states never leave, whatever is thrown at them.
    if (CLAIM_TRANSITIONS[record.state].length === 0) {
      for (const command of COMMANDS) expect(applyClaim(record, command, now, 'system').ok).toBe(false);
    }
  }

  expect([...reached].sort()).toEqual(['cancelled', 'closed', 'dispute']);
});

test('a seeded sweep of the HTTP-facing lifecycle keeps claim and payment in step', () => {
  const random = new SeededRandom(4_242);

  for (let round = 0; round < 60; round++) {
    const app = harness(1_700_000_000_000 + round * 60_000);
    const token = unwrap(createCardToken(app.context, cardTokenBody())).body as { id?: string };
    const payment = unwrap(createPayment(app.context, cardPaymentBody(token.id ?? ''))).body as { id?: number };
    const claim = unwrap(
      openClaim(app.context, { payment_id: payment.id, reason_id: 'PNR0001' }),
    ).body as Claim;
    const id = String(claim.id);

    const escalate = random.int(2) === 0;
    if (escalate) expect(requestClaimMediation(app.context, id).ok).toBe(true);

    const outcome = random.int(2) === 0 ? 'complainant' : 'respondent';
    const resolved = resolveClaim(app.context, id, outcome);
    expect(resolved.ok).toBe(escalate);

    const current = unwrap(getClaim(app.context, id)).body as Claim;
    const state = unwrap(getPayment(app.context, String(payment.id))).body as { status?: string };

    if (!escalate) {
      expect(current.stage).toBe('claim');
      expect(state.status).toBe('approved');
      expect(sendClaimMessage(app.context, id, { message: 'still open' }).ok).toBe(true);
      continue;
    }

    expect(current.status).toBe('closed');
    expect(current.stage).toBe('resolution');
    expect(state.status).toBe(outcome === 'complainant' ? 'refunded' : 'approved');
    // A closed claim takes no further traffic.
    expect(sendClaimMessage(app.context, id, { message: 'too late' }).ok).toBe(false);
  }
});
