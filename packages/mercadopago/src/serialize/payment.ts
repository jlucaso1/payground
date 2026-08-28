import { type Payment, type Refund, toDecimal } from '@payground/core';
import type { CurrencyId, Payment as PaymentResource, Refund as RefundResource } from '../generated/types.ts';
import { paymentTypeId, providerStatus } from '../mapping/status.ts';
import { compact } from './compact.ts';
import { formatDateTime, formatOptional } from './datetime.ts';
import type { BoletoArtifacts } from './boleto.ts';
import type { PixArtifacts } from './pix.ts';

export interface SerializedRefund {
  refund: Refund;
  sequence: number;
}

export interface PaymentContext {
  sequence: number;
  collectorId: number;
  liveMode: boolean;
  refunds: readonly SerializedRefund[];
  pix: PixArtifacts | null;
  boleto?: BoletoArtifacts | null;
  offsetMinutes?: number;
}

const CURRENCIES: readonly string[] = ['ARS', 'BRL', 'CLP', 'MXN', 'COP', 'PEN', 'UYU', 'USD', 'VES'];

/** The catalogue is closed in the spec; anything else would not round-trip through an SDK. */
function toCurrencyId(currency: string): CurrencyId {
  if (!CURRENCIES.includes(currency)) throw new Error(`unsupported currency: ${currency}`);
  return currency as CurrencyId;
}

export function serializeRefund(
  { refund, sequence }: SerializedRefund,
  offsetMinutes?: number,
): RefundResource {
  return compact<RefundResource>({
    id: sequence,
    payment_id: 0,
    amount: toDecimal(refund.amount),
    source: { id: 'payground', name: 'payground', type: 'collector' },
    date_created: formatDateTime(refund.createdAt, offsetMinutes),
    unique_sequence_number: null,
    refund_mode: 'standard',
    adjustment_amount: 0,
    status: refund.status === 'pending' ? 'in_process' : refund.status,
    reason: null,
  });
}

export function serializePayment(payment: Payment, context: PaymentContext): PaymentResource {
  const { status, status_detail } = providerStatus(payment);
  const offset = context.offsetMinutes;
  const amount = toDecimal(payment.amount);
  const refunded = toDecimal(payment.refundedAmount);
  const captured = payment.status.state === 'succeeded' || payment.status.state === 'refunded';
  const identification =
    payment.payer.documentNumber === null
      ? null
      : { type: payment.payer.documentType ?? 'CPF', number: payment.payer.documentNumber };

  return compact<PaymentResource>({
    id: context.sequence,
    date_created: formatDateTime(payment.createdAt, offset),
    date_approved: formatOptional(payment.settledAt, offset),
    date_last_updated: formatDateTime(payment.updatedAt, offset),
    date_of_expiration: formatOptional(payment.expiresAt, offset),
    money_release_date: formatOptional(payment.settledAt, offset),
    money_release_status: payment.settledAt === null ? null : 'released',
    operation_type: 'regular_payment',
    issuer_id: payment.method.card === null ? null : '24',
    payment_method_id: payment.method.code,
    payment_type_id: paymentTypeId(payment),
    payment_method: {
      id: payment.method.code,
      type: paymentTypeId(payment),
      issuer_id: payment.method.card === null ? null : '24',
    },
    status,
    status_detail,
    currency_id: toCurrencyId(payment.currency),
    description: payment.description ?? undefined,
    live_mode: context.liveMode,
    collector_id: context.collectorId,
    sponsor_id: null,
    authorization_code: payment.status.state === 'succeeded' ? String(context.sequence % 1_000_000) : null,
    call_for_authorize_id: null,
    payer: {
      id: String(context.collectorId + 1),
      email: payment.payer.email,
      type: 'guest',
      ...(identification === null ? {} : { identification }),
    },
    metadata: payment.metadata,
    external_reference: payment.externalReference ?? undefined,
    transaction_amount: amount,
    transaction_amount_refunded: refunded,
    coupon_amount: 0,
    net_amount: amount - refunded,
    taxes_amount: 0,
    shipping_amount: 0,
    counter_currency: null,
    differential_pricing_id: null,
    deduction_schema: null,
    pos_id: null,
    store_id: null,
    integrator_id: null,
    platform_id: null,
    corporation_id: null,
    merchant_account_id: null,
    merchant_number: null,
    callback_url: null,
    payment_method_option_id: null,
    transaction_details: {
      net_received_amount: captured ? toDecimal(payment.capturedAmount) - refunded : 0,
      total_paid_amount: captured ? toDecimal(payment.capturedAmount) : 0,
      overpaid_amount: 0,
      ...(context.pix !== null
        ? { external_resource_url: context.pix.ticket_url }
        : context.boleto == null
          ? {}
          : { external_resource_url: context.boleto.ticket_url, digitable_line: context.boleto.line }),
      installment_amount: amount / payment.installments,
    },
    fee_details: [],
    charges_details: [],
    captured,
    binary_mode: payment.binaryMode,
    installments: payment.installments,
    statement_descriptor: 'PAYGROUND',
    notification_url: payment.notificationUrl ?? undefined,
    processing_mode: 'aggregator',
    refunds: context.refunds.map((entry) => ({
      ...serializeRefund(entry, offset),
      payment_id: context.sequence,
    })),
    card:
      payment.method.card === null
        ? undefined
        : {
            first_six_digits: payment.method.card.bin,
            last_four_digits: payment.method.card.lastFour,
            expiration_month: payment.method.card.expiryMonth,
            expiration_year: payment.method.card.expiryYear,
            date_created: formatDateTime(payment.createdAt, offset),
            date_last_updated: formatDateTime(payment.updatedAt, offset),
            cardholder: {
              name: payment.method.card.holderName,
              ...(identification === null ? {} : { identification }),
            },
          },
    ...(context.boleto == null
      ? {}
      : { barcode: { type: 'itf', content: context.boleto.barcode, width: 2, height: 90 } }),
    point_of_interaction:
      context.pix === null
        ? undefined
        : {
            type: 'PIX',
            sub_type: null,
            application_data: { name: 'payground', version: '1.0' },
            transaction_data: {
              qr_code: context.pix.qr_code,
              qr_code_base64: context.pix.qr_code_base64,
              ticket_url: context.pix.ticket_url,
              transaction_id: null,
              bank_transfer_id: null,
              financial_institution: null,
            },
          },
  });
}
