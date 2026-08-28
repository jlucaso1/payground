import { type Result, ok } from '@payground/core';
import type { ErrorBody } from '../errors.ts';
import type { Rendered, ServiceContext } from './context.ts';

/**
 * The catalogue `GET /v1/payment_methods` returns for a Brazilian (MLB) collector.
 * Committed as literal data so the sandbox answers exactly the same thing every run.
 * https://www.mercadopago.com.br/developers/en/reference/payment_methods/_payment_methods/get
 */

interface FinancialInstitution {
  id: string;
  description: string;
}

interface CardSettings {
  bin: { pattern: string; installments_pattern: string; exclusion_pattern: string | null };
  card_number: { length: number; validation: 'standard' | 'none' };
  security_code: { length: number; card_location: 'back' | 'front'; mode: 'mandatory' | 'optional' };
}

export interface PaymentMethodEntry {
  id: string;
  name: string;
  payment_type_id: string;
  status: 'active' | 'deactivated';
  secure_thumbnail: string;
  thumbnail: string;
  deferred_capture: 'supported' | 'unsupported' | 'does_not_apply';
  settings: CardSettings[];
  additional_info_needed: string[];
  min_allowed_amount: number;
  max_allowed_amount: number;
  accreditation_time: number;
  financial_institutions: FinancialInstitution[];
  processing_modes: ('aggregator' | 'gateway')[];
}

const logo = (id: string): string => `https://http2.mlstatic.com/storage/logos-api-admin/${id}.gif`;

const cardSettings = (
  pattern: string,
  length: number,
  securityCode: number,
  location: 'back' | 'front' = 'back',
): CardSettings[] => [
  {
    bin: { pattern, installments_pattern: pattern, exclusion_pattern: null },
    card_number: { length, validation: 'standard' },
    security_code: { length: securityCode, card_location: location, mode: 'mandatory' },
  },
];

/** Card checkouts need the holder document; Mercado Pago rejects the payment without it. */
const CARD_INFO = ['cardholder_name', 'cardholder_identification_type', 'cardholder_identification_number'];

const credit = (
  id: string,
  name: string,
  pattern: string,
  length = 16,
  securityCode = 3,
  location: 'back' | 'front' = 'back',
): PaymentMethodEntry => ({
  id,
  name,
  payment_type_id: 'credit_card',
  status: 'active',
  secure_thumbnail: logo(id),
  thumbnail: logo(id),
  deferred_capture: 'supported',
  settings: cardSettings(pattern, length, securityCode, location),
  additional_info_needed: CARD_INFO,
  min_allowed_amount: 0.5,
  max_allowed_amount: 100_000,
  accreditation_time: 2880,
  financial_institutions: [],
  processing_modes: ['aggregator'],
});

/** Debit is captured at authorisation time, so deferred capture does not apply. */
const debit = (id: string, name: string, pattern: string): PaymentMethodEntry => ({
  ...credit(id, name, pattern),
  payment_type_id: 'debit_card',
  deferred_capture: 'does_not_apply',
  accreditation_time: 1440,
});

export const PAYMENT_METHODS: readonly PaymentMethodEntry[] = [
  {
    id: 'pix',
    name: 'Pix',
    payment_type_id: 'bank_transfer',
    status: 'active',
    secure_thumbnail: logo('pix'),
    thumbnail: logo('pix'),
    deferred_capture: 'does_not_apply',
    settings: [],
    additional_info_needed: [],
    min_allowed_amount: 0.01,
    max_allowed_amount: 100_000,
    accreditation_time: 0,
    financial_institutions: [],
    processing_modes: ['aggregator'],
  },
  {
    id: 'bolbradesco',
    name: 'Boleto',
    payment_type_id: 'ticket',
    status: 'active',
    secure_thumbnail: logo('bolbradesco'),
    thumbnail: logo('bolbradesco'),
    deferred_capture: 'does_not_apply',
    settings: [],
    additional_info_needed: ['entity_type'],
    min_allowed_amount: 1,
    max_allowed_amount: 100_000,
    accreditation_time: 2880,
    financial_institutions: [{ id: '1', description: 'Bradesco' }],
    processing_modes: ['aggregator'],
  },
  credit('visa', 'Visa', '^4\\d{5}'),
  credit('master', 'Mastercard', '^(?:5[1-5]|2(?:2[2-9]|[3-6]\\d|7[01]|720))\\d{4}'),
  credit('amex', 'American Express', '^3[47]\\d{4}', 15, 4, 'front'),
  credit('elo', 'Elo', '^(?:4011(?:78|79)|50(?:67|90)\\d{2}|65\\d{4})'),
  credit('hipercard', 'Hipercard', '^(?:606282|3841\\d{2})'),
  debit('debvisa', 'Visa Débito', '^4\\d{5}'),
  debit('debmaster', 'Mastercard Débito', '^(?:5[1-5]|2(?:2[2-9]|[3-6]\\d|7[01]|720))\\d{4}'),
  {
    id: 'account_money',
    name: 'Dinheiro na conta do Mercado Pago',
    payment_type_id: 'account_money',
    status: 'active',
    secure_thumbnail: logo('account_money'),
    thumbnail: logo('account_money'),
    deferred_capture: 'does_not_apply',
    settings: [],
    additional_info_needed: [],
    min_allowed_amount: 0.01,
    max_allowed_amount: 100_000,
    accreditation_time: 0,
    financial_institutions: [],
    processing_modes: ['aggregator'],
  },
];

export function listPaymentMethods(_context: ServiceContext): Result<Rendered, ErrorBody> {
  return ok({ status: 200, body: PAYMENT_METHODS });
}
