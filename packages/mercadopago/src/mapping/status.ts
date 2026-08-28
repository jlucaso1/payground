import type { DeclineReason, Payment, PaymentMethodKind } from '@payground/core';
import type { Payment as PaymentResource } from '../generated/types.ts';

type Status = NonNullable<PaymentResource['status']>;
type PaymentTypeId = NonNullable<PaymentResource['payment_type_id']>;

export interface ProviderStatus {
  status: Status;
  status_detail: string;
}

/**
 * Card declines use the `cc_rejected_*` family, everything else the `rejected_*` family.
 * https://www.mercadopago.com.br/developers/en/docs/checkout-api-payments/response-handling/query-results
 */
const CARD_DECLINE: Record<DeclineReason, string> = {
  insufficient_funds: 'cc_rejected_insufficient_amount',
  invalid_security_code: 'cc_rejected_bad_filled_security_code',
  expired_card: 'cc_rejected_bad_filled_date',
  invalid_card_number: 'cc_rejected_bad_filled_card_number',
  invalid_expiry_date: 'cc_rejected_bad_filled_date',
  invalid_data: 'cc_rejected_bad_filled_other',
  call_for_authorize: 'cc_rejected_call_for_authorize',
  card_disabled: 'cc_rejected_card_disabled',
  card_type_not_allowed: 'cc_rejected_card_type_not_allowed',
  high_risk: 'cc_rejected_high_risk',
  duplicate: 'cc_rejected_duplicated_payment',
  blacklisted: 'cc_rejected_blacklist',
  max_attempts: 'cc_rejected_max_attempts',
  invalid_installments: 'cc_rejected_invalid_installments',
  bank_error: 'bank_error',
  timeout: 'cc_rejected_time_out',
  unsupported: 'cc_rejected_other_reason',
  other: 'cc_rejected_other_reason',
};

const OTHER_DECLINE: Record<DeclineReason, string> = {
  insufficient_funds: 'insufficient_amount',
  invalid_security_code: 'rejected_insufficient_data',
  expired_card: 'rejected_other_reason',
  invalid_card_number: 'rejected_insufficient_data',
  invalid_expiry_date: 'rejected_other_reason',
  invalid_data: 'rejected_insufficient_data',
  call_for_authorize: 'rejected_by_bank',
  card_disabled: 'rejected_by_bank',
  card_type_not_allowed: 'rejected_by_biz_rule',
  high_risk: 'rejected_high_risk',
  duplicate: 'rejected_by_biz_rule',
  blacklisted: 'rejected_high_risk',
  max_attempts: 'rejected_by_biz_rule',
  invalid_installments: 'rejected_by_biz_rule',
  bank_error: 'bank_error',
  timeout: 'rejected_other_reason',
  unsupported: 'rejected_other_reason',
  other: 'rejected_other_reason',
};

/** Offline methods wait for the payer at the bank; vouchers wait for the payment itself. */
const awaitingPayer = (kind: PaymentMethodKind): string =>
  kind === 'bank_transfer' ? 'pending_waiting_transfer' : 'pending_waiting_payment';

export function providerStatus(payment: Payment): ProviderStatus {
  const { status } = payment;
  switch (status.state) {
    case 'pending':
      return {
        status: 'pending',
        status_detail:
          status.reason === 'awaiting_challenge' ? 'pending_challenge' : awaitingPayer(payment.method.kind),
      };
    case 'authorized':
      return { status: 'authorized', status_detail: 'pending_capture' };
    case 'in_review':
      return {
        status: 'in_process',
        status_detail:
          status.reason === 'manual_review'
            ? 'pending_review_manual'
            : status.reason === 'contingency'
              ? 'pending_contingency'
              : 'offline_process',
      };
    case 'succeeded':
      return {
        status: 'approved',
        status_detail: payment.refundedAmount > 0 ? 'partially_refunded' : 'accredited',
      };
    case 'failed':
      return {
        status: 'rejected',
        status_detail:
          payment.method.kind === 'card' ? CARD_DECLINE[status.reason] : OTHER_DECLINE[status.reason],
      };
    case 'cancelled':
      return { status: 'cancelled', status_detail: status.reason };
    case 'refunded':
      return { status: 'refunded', status_detail: 'refunded' };
    case 'in_mediation':
      return { status: 'in_mediation', status_detail: 'pending' };
    case 'charged_back':
      return { status: 'charged_back', status_detail: status.reason };
  }
}

/** Payment type identifiers, as the API reports them. */
const PAYMENT_TYPE: Record<PaymentMethodKind, PaymentTypeId> = {
  card: 'credit_card',
  bank_transfer: 'bank_transfer',
  voucher: 'ticket',
  wallet: 'account_money',
};

/** Debit cards ride the same brands under a `deb`-prefixed catalogue code (`debvisa`). */
const isDebitCode = (code: string): boolean => code === 'debit_card' || code.startsWith('deb');

export const paymentTypeId = (payment: Payment): PaymentTypeId =>
  payment.method.kind === 'card' && isDebitCode(payment.method.code)
    ? 'debit_card'
    : PAYMENT_TYPE[payment.method.kind];
