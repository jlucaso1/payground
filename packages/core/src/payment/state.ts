import type { Minor } from '../money.ts';

export type PaymentState =
  | 'pending'
  | 'authorized'
  | 'in_review'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'refunded'
  | 'in_mediation'
  | 'charged_back';

/** Why a payment was declined. Provider-neutral; the adapter maps these to status_detail. */
export type DeclineReason =
  | 'insufficient_funds'
  | 'invalid_security_code'
  | 'expired_card'
  | 'invalid_card_number'
  | 'invalid_expiry_date'
  | 'invalid_data'
  | 'call_for_authorize'
  | 'card_disabled'
  | 'card_type_not_allowed'
  | 'high_risk'
  | 'duplicate'
  | 'blacklisted'
  | 'max_attempts'
  | 'invalid_installments'
  | 'bank_error'
  | 'timeout'
  | 'unsupported'
  | 'other';

/** State and reason travel together, so an impossible pair cannot be constructed. */
export type PaymentStatus =
  | { readonly state: 'pending'; readonly reason: 'awaiting_payer' | 'awaiting_challenge' }
  | { readonly state: 'authorized'; readonly reason: 'awaiting_capture' }
  | { readonly state: 'in_review'; readonly reason: 'manual_review' | 'contingency' | 'offline' }
  | { readonly state: 'succeeded'; readonly reason: 'settled' }
  | { readonly state: 'failed'; readonly reason: DeclineReason }
  | { readonly state: 'cancelled'; readonly reason: 'expired' | 'by_collector' | 'by_payer' }
  | { readonly state: 'refunded'; readonly reason: 'refunded' }
  | { readonly state: 'in_mediation'; readonly reason: 'disputed' }
  | { readonly state: 'charged_back'; readonly reason: 'in_process' | 'settled' | 'reimbursed' };

export type PaymentCommand =
  | { readonly type: 'settle' }
  | { readonly type: 'review'; readonly reason: 'manual_review' | 'contingency' | 'offline' }
  | { readonly type: 'decline'; readonly reason: DeclineReason }
  | { readonly type: 'expire' }
  | { readonly type: 'cancel'; readonly by: 'collector' | 'payer' }
  | { readonly type: 'capture'; readonly amount: Minor | null }
  | { readonly type: 'refund'; readonly amount: Minor }
  | { readonly type: 'dispute' }
  | { readonly type: 'resolve'; readonly outcome: 'chargeback' | 'merchant' };

export type PaymentCommandType = PaymentCommand['type'];

/** The whole state machine, as data. Nothing transitions unless it is listed here. */
export const TRANSITIONS = {
  pending: ['settle', 'review', 'decline', 'expire', 'cancel'],
  authorized: ['capture', 'cancel', 'expire'],
  in_review: ['settle', 'decline'],
  succeeded: ['refund', 'dispute'],
  failed: [],
  cancelled: [],
  refunded: [],
  in_mediation: ['resolve'],
  charged_back: [],
} as const satisfies Record<PaymentState, readonly PaymentCommandType[]>;

export const TERMINAL: readonly PaymentState[] = ['failed', 'cancelled', 'refunded', 'charged_back'];

export function isAllowed(state: PaymentState, command: PaymentCommandType): boolean {
  return (TRANSITIONS[state] as readonly PaymentCommandType[]).includes(command);
}

export function isTerminal(state: PaymentState): boolean {
  return TRANSITIONS[state].length === 0;
}
