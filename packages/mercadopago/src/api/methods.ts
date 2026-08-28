import type { PaymentMethodKind } from '@payground/core';

/** Method catalogue payground emulates. Card entries arrive through a card token. */
export const METHOD_KINDS: Record<string, PaymentMethodKind> = {
  pix: 'bank_transfer',
  account_money: 'wallet',
  bolbradesco: 'voucher',
  bolbradesco_pec: 'voucher',
  pec: 'voucher',
};

export const CARD_BRANDS: readonly string[] = [
  'visa', 'master', 'amex', 'elo', 'hipercard', 'debvisa', 'debmaster', 'debelo',
];

export function methodKind(code: string): PaymentMethodKind | null {
  const known = METHOD_KINDS[code];
  if (known !== undefined) return known;
  return CARD_BRANDS.includes(code) ? 'card' : null;
}

/** Default lifetime of a Pix charge; the API allows 30 minutes to 30 days. */
export const PIX_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const PIX_MIN_TTL_MS = 30 * 60 * 1000;
export const PIX_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const VOUCHER_DEFAULT_TTL_MS = 3 * 24 * 60 * 60 * 1000;
