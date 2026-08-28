import { describe, expect, test } from 'bun:test';
import type { DeclineReason, Payment } from '@payground/core';
import { CARD, PIX, amount, payment } from '@payground/core/payment/fixture.ts';
import { paymentTypeId, providerStatus } from './status.ts';

const withStatus = (base: Payment, status: Payment['status']): Payment => ({ ...base, status });

const DECLINES: DeclineReason[] = [
  'insufficient_funds', 'invalid_security_code', 'expired_card', 'invalid_card_number',
  'invalid_expiry_date', 'invalid_data', 'call_for_authorize', 'card_disabled',
  'card_type_not_allowed', 'high_risk', 'duplicate', 'blacklisted', 'max_attempts',
  'invalid_installments', 'bank_error', 'timeout', 'unsupported', 'other',
];

describe('provider status mapping', () => {
  test('a pending Pix waits for the transfer', () => {
    expect(providerStatus(payment())).toEqual({
      status: 'pending',
      status_detail: 'pending_waiting_transfer',
    });
  });

  test('a pending voucher waits for the payment', () => {
    const boleto = { ...payment(), method: { kind: 'voucher' as const, code: 'bolbradesco', card: null } };
    expect(providerStatus(boleto).status_detail).toBe('pending_waiting_payment');
  });

  test('a challenge is reported separately from waiting', () => {
    const p = withStatus(payment(), { state: 'pending', reason: 'awaiting_challenge' });
    expect(providerStatus(p).status_detail).toBe('pending_challenge');
  });

  test('authorized maps to pending_capture', () => {
    expect(providerStatus(payment({ kind: 'authorize' }, { method: CARD }))).toEqual({
      status: 'authorized',
      status_detail: 'pending_capture',
    });
  });

  test('review reasons map onto the in_process family', () => {
    const cases = [
      ['manual_review', 'pending_review_manual'],
      ['contingency', 'pending_contingency'],
      ['offline', 'offline_process'],
    ] as const;
    for (const [reason, detail] of cases) {
      const p = withStatus(payment(), { state: 'in_review', reason });
      expect(providerStatus(p)).toEqual({ status: 'in_process', status_detail: detail });
    }
  });

  test('a settled payment is accredited until it is partially refunded', () => {
    const settled = payment({ kind: 'settle' });
    expect(providerStatus(settled).status_detail).toBe('accredited');
    expect(providerStatus({ ...settled, refundedAmount: amount(1) }).status_detail).toBe('partially_refunded');
  });

  test('every decline reason maps to a distinct documented detail per method family', () => {
    for (const reason of DECLINES) {
      const card = providerStatus(withStatus({ ...payment(), method: CARD }, { state: 'failed', reason }));
      const pix = providerStatus(withStatus({ ...payment(), method: PIX }, { state: 'failed', reason }));
      expect(card.status).toBe('rejected');
      expect(pix.status).toBe('rejected');
      expect(card.status_detail).toMatch(/^(cc_rejected_|bank_error)/);
      expect(pix.status_detail).toMatch(/^(rejected_|insufficient_amount|bank_error)/);
    }
  });

  test('cancellation and chargeback reasons pass through unchanged', () => {
    for (const reason of ['expired', 'by_collector', 'by_payer'] as const) {
      expect(providerStatus(withStatus(payment(), { state: 'cancelled', reason }))).toEqual({
        status: 'cancelled',
        status_detail: reason,
      });
    }
    for (const reason of ['in_process', 'settled', 'reimbursed'] as const) {
      expect(providerStatus(withStatus(payment(), { state: 'charged_back', reason }))).toEqual({
        status: 'charged_back',
        status_detail: reason,
      });
    }
  });

  test('refunded and mediation', () => {
    expect(providerStatus(withStatus(payment(), { state: 'refunded', reason: 'refunded' }))).toEqual({
      status: 'refunded',
      status_detail: 'refunded',
    });
    expect(providerStatus(withStatus(payment(), { state: 'in_mediation', reason: 'disputed' }))).toEqual({
      status: 'in_mediation',
      status_detail: 'pending',
    });
  });

  test('payment type identifiers', () => {
    expect(paymentTypeId(payment())).toBe('bank_transfer');
    expect(paymentTypeId({ ...payment(), method: CARD })).toBe('credit_card');
    expect(paymentTypeId({ ...payment(), method: { kind: 'card', code: 'debit_card', card: null } })).toBe('debit_card');
    expect(paymentTypeId({ ...payment(), method: { kind: 'wallet', code: 'account_money', card: null } })).toBe('account_money');
    expect(paymentTypeId({ ...payment(), method: { kind: 'voucher', code: 'bolbradesco', card: null } })).toBe('ticket');
  });
});
