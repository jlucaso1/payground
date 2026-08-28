import type { PaymentId, SandboxId } from '../ids.ts';
import type { JsonObject } from '../json.ts';
import { type Minor, ZERO, add, subtract } from '../money.ts';
import { type Result, err, ok } from '../result.ts';
import {
  type PaymentCommand,
  type PaymentStatus,
  isAllowed,
} from './state.ts';

export type PaymentMethodKind = 'card' | 'bank_transfer' | 'voucher' | 'wallet';

export interface CardSnapshot {
  readonly bin: string;
  readonly lastFour: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
  readonly holderName: string;
  readonly brand: string;
}

export interface PaymentMethod {
  readonly kind: PaymentMethodKind;
  /** Catalogue code for the method, e.g. `pix`, `visa`, `bolbradesco`. */
  readonly code: string;
  readonly card: CardSnapshot | null;
}

export interface Payer {
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly documentType: string | null;
  readonly documentNumber: string | null;
}

export interface Payment {
  readonly id: PaymentId;
  readonly sandbox: SandboxId;
  readonly status: PaymentStatus;
  readonly method: PaymentMethod;
  readonly payer: Payer;
  readonly amount: Minor;
  readonly capturedAmount: Minor;
  readonly refundedAmount: Minor;
  readonly currency: string;
  readonly installments: number;
  readonly binaryMode: boolean;
  readonly captureOnCreate: boolean;
  readonly description: string | null;
  readonly externalReference: string | null;
  readonly notificationUrl: string | null;
  readonly metadata: JsonObject;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly settledAt: number | null;
  readonly expiresAt: number | null;
}

export type PaymentError =
  | { kind: 'invalid_transition'; from: PaymentStatus; command: PaymentCommand['type'] }
  | { kind: 'not_expired'; expiresAt: number | null; now: number }
  | { kind: 'capture_exceeds_authorized'; authorized: Minor; requested: Minor }
  | { kind: 'refund_exceeds_remaining'; remaining: Minor; requested: Minor }
  | { kind: 'amount_not_positive' }
  | { kind: 'binary_mode_forbids_review' };

export interface Transition {
  readonly payment: Payment;
  readonly from: PaymentStatus;
  readonly to: PaymentStatus;
  readonly command: PaymentCommand;
  readonly at: number;
}

export const refundable = (payment: Payment): Minor =>
  (payment.capturedAmount - payment.refundedAmount) as Minor;

export function apply(
  payment: Payment,
  command: PaymentCommand,
  now: number,
): Result<Transition, PaymentError> {
  if (!isAllowed(payment.status.state, command.type)) {
    return err({ kind: 'invalid_transition', from: payment.status, command: command.type });
  }

  const next = resolve(payment, command, now);
  if (!next.ok) return next;

  const updated: Payment = { ...payment, ...next.value, updatedAt: now };
  return ok({ payment: updated, from: payment.status, to: updated.status, command, at: now });
}

type Patch = Partial<Payment> & { status: PaymentStatus };

function resolve(payment: Payment, command: PaymentCommand, now: number): Result<Patch, PaymentError> {
  switch (command.type) {
    case 'settle':
      return ok({
        status: { state: 'succeeded', reason: 'settled' },
        capturedAmount: payment.amount,
        settledAt: now,
      });

    case 'review':
      if (payment.binaryMode) return err({ kind: 'binary_mode_forbids_review' });
      return ok({ status: { state: 'in_review', reason: command.reason } });

    case 'decline':
      return ok({ status: { state: 'failed', reason: command.reason } });

    case 'expire':
      if (payment.expiresAt === null || now < payment.expiresAt) {
        return err({ kind: 'not_expired', expiresAt: payment.expiresAt, now });
      }
      return ok({ status: { state: 'cancelled', reason: 'expired' } });

    case 'cancel':
      return ok({
        status: { state: 'cancelled', reason: command.by === 'payer' ? 'by_payer' : 'by_collector' },
      });

    case 'capture': {
      const requested = command.amount ?? payment.amount;
      if (requested <= 0) return err({ kind: 'amount_not_positive' });
      if (requested > payment.amount) {
        return err({ kind: 'capture_exceeds_authorized', authorized: payment.amount, requested });
      }
      return ok({
        status: { state: 'succeeded', reason: 'settled' },
        capturedAmount: requested,
        settledAt: now,
      });
    }

    case 'refund': {
      if (command.amount <= 0) return err({ kind: 'amount_not_positive' });
      const remaining = refundable(payment);
      if (command.amount > remaining) {
        return err({ kind: 'refund_exceeds_remaining', remaining, requested: command.amount });
      }
      const total = add(payment.refundedAmount, command.amount);
      if (!total.ok) return err({ kind: 'amount_not_positive' });
      const left = subtract(remaining, command.amount);
      const fullyRefunded = left.ok && left.value === ZERO;
      return ok({
        status: fullyRefunded
          ? { state: 'refunded', reason: 'refunded' }
          : { state: 'succeeded', reason: 'settled' },
        refundedAmount: total.value,
      });
    }

    case 'dispute':
      return ok({ status: { state: 'in_mediation', reason: 'disputed' } });

    case 'resolve':
      return ok({
        status:
          command.outcome === 'chargeback'
            ? { state: 'charged_back', reason: 'settled' }
            : { state: 'succeeded', reason: 'settled' },
      });
  }
}
