import type { PaymentId, SandboxId } from '../ids.ts';
import type { JsonObject } from '../json.ts';
import { type Minor, ZERO } from '../money.ts';
import { type Result, err, ok } from '../result.ts';
import type { Payer, Payment, PaymentError, PaymentMethod } from './payment.ts';
import type { DeclineReason, PaymentStatus } from './state.ts';

/**
 * How a newly created payment resolves. The domain does not decide this, the provider
 * adapter does, from its own rules (test cardholder names, method behaviour, injected
 * faults), so no provider logic leaks into the core.
 */
export type PaymentDecision =
  | { readonly kind: 'settle' }
  | { readonly kind: 'authorize' }
  | { readonly kind: 'pending'; readonly reason: 'awaiting_payer' | 'awaiting_challenge' }
  | { readonly kind: 'review'; readonly reason: 'manual_review' | 'contingency' | 'offline' }
  | { readonly kind: 'decline'; readonly reason: DeclineReason };

export interface CreatePayment {
  readonly id: PaymentId;
  readonly sandbox: SandboxId;
  readonly method: PaymentMethod;
  readonly payer: Payer;
  readonly amount: Minor;
  readonly currency: string;
  readonly installments: number;
  readonly binaryMode: boolean;
  readonly captureOnCreate: boolean;
  readonly description: string | null;
  readonly externalReference: string | null;
  readonly notificationUrl: string | null;
  readonly metadata: JsonObject;
  readonly expiresAt: number | null;
}

export type CreateError =
  | PaymentError
  | { kind: 'amount_not_positive' }
  | { kind: 'invalid_installments'; installments: number }
  | { kind: 'expiry_in_the_past'; expiresAt: number; now: number };

function initialStatus(decision: PaymentDecision): PaymentStatus {
  switch (decision.kind) {
    case 'settle':
      return { state: 'succeeded', reason: 'settled' };
    case 'authorize':
      return { state: 'authorized', reason: 'awaiting_capture' };
    case 'pending':
      return { state: 'pending', reason: decision.reason };
    case 'review':
      return { state: 'in_review', reason: decision.reason };
    case 'decline':
      return { state: 'failed', reason: decision.reason };
  }
}

export function create(
  input: CreatePayment,
  decision: PaymentDecision,
  now: number,
): Result<Payment, CreateError> {
  if (input.amount <= 0) return err({ kind: 'amount_not_positive' });
  if (!Number.isInteger(input.installments) || input.installments < 1) {
    return err({ kind: 'invalid_installments', installments: input.installments });
  }
  if (input.expiresAt !== null && input.expiresAt <= now) {
    return err({ kind: 'expiry_in_the_past', expiresAt: input.expiresAt, now });
  }
  if (input.binaryMode && (decision.kind === 'review' || decision.kind === 'pending')) {
    return err({ kind: 'binary_mode_forbids_review' });
  }

  const status = initialStatus(decision);
  const settled = status.state === 'succeeded';

  return ok({
    ...input,
    status,
    capturedAmount: settled ? input.amount : ZERO,
    refundedAmount: ZERO,
    createdAt: now,
    updatedAt: now,
    settledAt: settled ? now : null,
  });
}
