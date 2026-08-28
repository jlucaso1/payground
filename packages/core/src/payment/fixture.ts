import { paymentId, sandboxId } from '../ids.ts';
import { type Minor, minor } from '../money.ts';
import { unwrap } from '../result.ts';
import { type CreatePayment, type PaymentDecision, create } from './create.ts';
import type { Payment, PaymentMethod } from './payment.ts';

export const PIX: PaymentMethod = { kind: 'bank_transfer', code: 'pix', card: null };
export const CARD: PaymentMethod = {
  kind: 'card',
  code: 'visa',
  card: {
    bin: '423564',
    lastFour: '5682',
    expiryMonth: 11,
    expiryYear: 2030,
    holderName: 'APRO',
    brand: 'visa',
  },
};

export const amount = (cents: number): Minor => unwrap(minor(cents));

export function input(overrides: Partial<CreatePayment> = {}): CreatePayment {
  return {
    id: paymentId('p-1'),
    sandbox: sandboxId('s-1'),
    method: PIX,
    payer: {
      email: 'payer@example.com',
      firstName: null,
      lastName: null,
      documentType: 'CPF',
      documentNumber: '12345678909',
    },
    amount: amount(10_000),
    currency: 'BRL',
    installments: 1,
    binaryMode: false,
    captureOnCreate: true,
    description: null,
    externalReference: null,
    notificationUrl: null,
    metadata: {},
    expiresAt: null,
    ...overrides,
  };
}

export function payment(
  decision: PaymentDecision = { kind: 'pending', reason: 'awaiting_payer' },
  overrides: Partial<CreatePayment> = {},
  now = 1_000,
): Payment {
  return unwrap(create(input(overrides), decision, now));
}
