import {
  type Minor,
  type Payment,
  type PaymentMethodKind,
  type Refund,
  paymentId,
  refundId,
} from '@payground/core';
import type { ServiceContext } from './context.ts';

export interface SeededPayment {
  amount: number;
  captured?: number;
  installments?: number;
  kind?: PaymentMethodKind;
  code?: string;
  settledAt: number | null;
  description?: string;
  externalReference?: string | null;
  refunds?: readonly { amount: number; at: number; approved?: boolean }[];
}

/** Test-only: writes payments and refunds straight into the store, bypassing the API. */
export function seedLedger(context: ServiceContext, entries: readonly SeededPayment[]): void {
  for (const entry of entries) {
    const index = context.store.nextSequence('seed');
    const id = paymentId(`pay-${index}`);
    const captured = entry.captured ?? entry.amount;
    const refunded = (entry.refunds ?? [])
      .filter((refund) => refund.approved !== false)
      .reduce((total, refund) => total + refund.amount, 0);
    const kind = entry.kind ?? 'card';
    const payment: Payment = {
      id,
      sandbox: context.store.id,
      status:
        entry.settledAt === null
          ? { state: 'pending', reason: 'awaiting_payer' }
          : refunded > 0 && refunded === captured
            ? { state: 'refunded', reason: 'refunded' }
            : { state: 'succeeded', reason: 'settled' },
      method: { kind, code: entry.code ?? (kind === 'card' ? 'visa' : 'pix'), card: null },
      payer: { email: 'payer@example.com', firstName: null, lastName: null, documentType: null, documentNumber: null },
      amount: entry.amount as Minor,
      capturedAmount: (entry.settledAt === null ? 0 : captured) as Minor,
      refundedAmount: refunded as Minor,
      currency: 'BRL',
      installments: entry.installments ?? 1,
      binaryMode: false,
      captureOnCreate: true,
      description: entry.description ?? null,
      externalReference: entry.externalReference ?? null,
      notificationUrl: null,
      metadata: {},
      createdAt: entry.settledAt ?? 0,
      updatedAt: entry.settledAt ?? 0,
      settledAt: entry.settledAt,
      expiresAt: null,
    };
    context.store.payments.insert(payment, context.store.nextSequence('payment'));

    (entry.refunds ?? []).forEach((refund, position) => {
      const record: Refund = {
        id: refundId(`ref-${index}-${position}`),
        sandbox: context.store.id,
        paymentId: id,
        amount: refund.amount as Minor,
        status: refund.approved === false ? 'rejected' : 'approved',
        partial: refund.amount < captured,
        createdAt: refund.at,
      };
      context.store.refunds.insert(record, context.store.nextSequence('refund'));
    });
  }
}
