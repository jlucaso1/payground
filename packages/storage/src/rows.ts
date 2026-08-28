import {
  type CardSnapshot,
  type JsonObject,
  type Minor,
  type Payment,
  type PaymentId,
  type PaymentStatus,
  type Refund,
  type RefundStatus,
  type SandboxId,
  isJsonObject,
  paymentId,
  refundId,
  sandboxId,
} from '@payground/core';

export interface PaymentRow {
  id: string;
  sandbox_id: string;
  sequence: number;
  state: string;
  reason: string;
  method_kind: string;
  method_code: string;
  card: string | null;
  payer_email: string;
  payer_first_name: string | null;
  payer_last_name: string | null;
  payer_document_type: string | null;
  payer_document_number: string | null;
  amount: number;
  captured_amount: number;
  refunded_amount: number;
  currency: string;
  installments: number;
  binary_mode: number;
  capture_on_create: number;
  description: string | null;
  external_reference: string | null;
  notification_url: string | null;
  metadata: string;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
  expires_at: number | null;
}

export interface RefundRow {
  id: string;
  sandbox_id: string;
  sequence: number;
  payment_id: string;
  amount: number;
  status: string;
  partial: number;
  created_at: number;
}

export interface EventRow {
  seq: number;
  at: number;
  command: string;
  from_state: string;
  from_reason: string;
  to_state: string;
  to_reason: string;
}

const STATUS_REASONS: Record<string, readonly string[]> = {
  pending: ['awaiting_payer', 'awaiting_challenge'],
  authorized: ['awaiting_capture'],
  in_review: ['manual_review', 'contingency', 'offline'],
  succeeded: ['settled'],
  cancelled: ['expired', 'by_collector', 'by_payer'],
  refunded: ['refunded'],
  in_mediation: ['disputed'],
  charged_back: ['in_process', 'settled', 'reimbursed'],
};

/** The database is ours, so a shape mismatch is corruption, not user input. */
function corrupt(what: string, value: unknown): never {
  throw new Error(`corrupt row: ${what} = ${JSON.stringify(value)}`);
}

export function toStatus(state: string, reason: string): PaymentStatus {
  if (state === 'failed') return { state, reason } as PaymentStatus;
  const allowed = STATUS_REASONS[state];
  if (allowed === undefined || !allowed.includes(reason)) corrupt('status', `${state}/${reason}`);
  return { state, reason } as PaymentStatus;
}

const money = (value: number): Minor => {
  if (!Number.isInteger(value) || value < 0) corrupt('amount', value);
  return value as Minor;
};

function toCard(raw: string | null): CardSnapshot | null {
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!isJsonObject(parsed)) corrupt('card', raw);
  return parsed as unknown as CardSnapshot;
}

function toMetadata(raw: string): JsonObject {
  const parsed: unknown = JSON.parse(raw);
  if (!isJsonObject(parsed)) corrupt('metadata', raw);
  return parsed;
}

function toMethodKind(value: string): Payment['method']['kind'] {
  if (value === 'card' || value === 'bank_transfer' || value === 'voucher' || value === 'wallet') return value;
  return corrupt('method_kind', value);
}

export function toPayment(row: PaymentRow): Payment {
  return {
    id: paymentId(row.id),
    sandbox: sandboxId(row.sandbox_id),
    status: toStatus(row.state, row.reason),
    method: { kind: toMethodKind(row.method_kind), code: row.method_code, card: toCard(row.card) },
    payer: {
      email: row.payer_email,
      firstName: row.payer_first_name,
      lastName: row.payer_last_name,
      documentType: row.payer_document_type,
      documentNumber: row.payer_document_number,
    },
    amount: money(row.amount),
    capturedAmount: money(row.captured_amount),
    refundedAmount: money(row.refunded_amount),
    currency: row.currency,
    installments: row.installments,
    binaryMode: row.binary_mode === 1,
    captureOnCreate: row.capture_on_create === 1,
    description: row.description,
    externalReference: row.external_reference,
    notificationUrl: row.notification_url,
    metadata: toMetadata(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
    expiresAt: row.expires_at,
  };
}

function toRefundStatus(value: string): RefundStatus {
  if (value === 'pending' || value === 'approved' || value === 'rejected' || value === 'cancelled') return value;
  return corrupt('refund status', value);
}

export function toRefund(row: RefundRow): Refund {
  return {
    id: refundId(row.id),
    sandbox: sandboxId(row.sandbox_id) as SandboxId,
    paymentId: paymentId(row.payment_id) as PaymentId,
    amount: money(row.amount),
    status: toRefundStatus(row.status),
    partial: row.partial === 1,
    createdAt: row.created_at,
  };
}
