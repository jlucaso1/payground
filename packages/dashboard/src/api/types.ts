export interface Sandbox {
  id: string;
  name: string;
  accessToken: string;
  publicKey: string;
  webhookSecret: string;
  liveMode: boolean;
  createdAt: number;
}

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

export const PAYMENT_STATES: readonly PaymentState[] = [
  'pending',
  'authorized',
  'in_review',
  'succeeded',
  'failed',
  'cancelled',
  'refunded',
  'in_mediation',
  'charged_back',
];

export interface PaymentView {
  id: string;
  sequence: number;
  state: PaymentState;
  reason: string;
  providerStatus: string;
  providerStatusDetail: string;
  methodKind: string;
  methodCode: string;
  amount: number;
  capturedAmount: number;
  refundedAmount: number;
  currency: string;
  payerEmail: string;
  description: string | null;
  externalReference: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

export interface TimelineEntry {
  at: number;
  command: { type: string } & Record<string, unknown>;
  from: { state: string; reason: string };
  to: { state: string; reason: string };
}

export interface RefundView {
  id: string;
  sequence: number;
  amount: number;
  status: string;
  partial: boolean;
  createdAt: number;
}

export type WebhookStatus = 'queued' | 'sending' | 'delivered' | 'retrying' | 'exhausted';

export interface WebhookDeliveryView {
  id: string;
  paymentId: string | null;
  event: string;
  url: string;
  status: WebhookStatus;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  requestHeaders: Record<string, string>;
  requestBody: string;
  responseBody: string | null;
  nextAttemptAt: number | null;
  createdAt: number;
}

export interface FaultProfile {
  latencyMs: number;
  errorRate: number;
  unavailable: boolean;
  duplicateWebhooks: boolean;
  webhookFailureRate: number;
}

export interface HealthView {
  status: 'ok';
  version: string;
  uptime_ms: number;
}

export interface PaymentPage {
  total: number;
  limit: number;
  offset: number;
  results: PaymentView[];
}

export interface PaymentDetail {
  payment: PaymentView;
  timeline: TimelineEntry[];
  refunds: RefundView[];
}

export interface OkResponse {
  ok: true;
}

export type PaymentAction =
  | { type: 'settle' }
  | { type: 'decline'; reason: string }
  | { type: 'expire' }
  | { type: 'cancel'; by: 'collector' | 'payer' }
  | { type: 'capture'; amount: number | null }
  | { type: 'refund'; amount: number }
  | { type: 'dispute' }
  | { type: 'resolve'; outcome: 'chargeback' | 'merchant' };

export type PaymentActionType = PaymentAction['type'];

export interface PaymentQuery {
  state?: PaymentState;
  method?: string;
  external_reference?: string;
  limit?: number;
  offset?: number;
}
