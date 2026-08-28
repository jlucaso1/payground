import type { PaymentDecision, PaymentMethod } from '@payground/core';

/**
 * Cardholder names drive the outcome in the real sandbox. The full table is 18 codes, not
 * the 8 usually quoted.
 * https://www.mercadopago.com.br/developers/en/docs/your-integrations/test/cards
 */
export const CARDHOLDER_DECISIONS: Record<string, PaymentDecision> = {
  APRO: { kind: 'settle' },
  OTHE: { kind: 'decline', reason: 'other' },
  CONT: { kind: 'review', reason: 'contingency' },
  CALL: { kind: 'decline', reason: 'call_for_authorize' },
  FUND: { kind: 'decline', reason: 'insufficient_funds' },
  SECU: { kind: 'decline', reason: 'invalid_security_code' },
  EXPI: { kind: 'decline', reason: 'expired_card' },
  FORM: { kind: 'decline', reason: 'invalid_data' },
  CARD: { kind: 'decline', reason: 'invalid_card_number' },
  INST: { kind: 'decline', reason: 'invalid_installments' },
  DUPL: { kind: 'decline', reason: 'duplicate' },
  LOCK: { kind: 'decline', reason: 'card_disabled' },
  CTNA: { kind: 'decline', reason: 'card_type_not_allowed' },
  ATTE: { kind: 'decline', reason: 'max_attempts' },
  BLAC: { kind: 'decline', reason: 'blacklisted' },
  UNSU: { kind: 'decline', reason: 'unsupported' },
  TEST: { kind: 'settle' },
};

export interface DecisionInput {
  method: PaymentMethod;
  capture: boolean;
  binaryMode: boolean;
}

export function decide(input: DecisionInput): PaymentDecision {
  switch (input.method.kind) {
    case 'bank_transfer':
    case 'voucher':
      return { kind: 'pending', reason: 'awaiting_payer' };
    case 'wallet':
      return { kind: 'settle' };
    case 'card': {
      const name = input.method.card?.holderName.trim().toUpperCase() ?? '';
      const mapped = CARDHOLDER_DECISIONS[name] ?? { kind: 'settle' };
      if (mapped.kind === 'review' && input.binaryMode) return { kind: 'decline', reason: 'other' };
      if (mapped.kind === 'settle' && !input.capture) return { kind: 'authorize' };
      return mapped;
    }
  }
}
