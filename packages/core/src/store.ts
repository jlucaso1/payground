import type { PaymentId, RefundId, SandboxId, WebhookDeliveryId } from './ids.ts';
import type { JsonObject } from './json.ts';
import type { Payment, Transition } from './payment/payment.ts';
import type { Refund } from './payment/refund.ts';
import type { PaymentState } from './payment/state.ts';

export interface Page<T> {
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly results: readonly T[];
}

export interface PaymentQuery {
  readonly states?: readonly PaymentState[];
  readonly methodCode?: string;
  readonly externalReference?: string;
  readonly payerEmail?: string;
  readonly createdFrom?: number;
  readonly createdTo?: number;
  /** Payments whose deadline has passed and that are still awaiting the payer. */
  readonly expiredBy?: number;
  readonly limit?: number;
  readonly offset?: number;
  readonly sort?: 'date_created';
  readonly order?: 'asc' | 'desc';
}

export interface PaymentRepository {
  insert(payment: Payment, sequence: number): void;
  get(id: PaymentId): Payment | null;
  bySequence(sequence: number): Payment | null;
  sequenceOf(id: PaymentId): number | null;
  update(payment: Payment): void;
  search(query: PaymentQuery): Page<Payment>;
  record(transition: Transition): void;
  timeline(id: PaymentId): readonly Transition[];
}

export interface RefundRepository {
  insert(refund: Refund, sequence: number): void;
  get(id: RefundId): Refund | null;
  bySequence(sequence: number): Refund | null;
  sequenceOf(id: RefundId): number | null;
  listFor(paymentId: PaymentId): readonly Refund[];
}

export interface IdempotencyRecord {
  readonly key: string;
  readonly fingerprint: string;
  readonly status: number;
  readonly body: string;
  readonly createdAt: number;
}

export interface IdempotencyStore {
  get(key: string): IdempotencyRecord | null;
  put(record: IdempotencyRecord): void;
  purgeBefore(cutoff: number): number;
}

export interface Sandbox {
  readonly id: SandboxId;
  readonly name: string;
  readonly accessToken: string;
  readonly publicKey: string;
  readonly webhookSecret: string;
  readonly liveMode: boolean;
  readonly createdAt: number;
}

export interface SandboxStore {
  readonly id: SandboxId;
  readonly payments: PaymentRepository;
  readonly refunds: RefundRepository;
  readonly idempotency: IdempotencyStore;
  readonly documents: DocumentRepository;
  readonly webhooks: WebhookRepository;
  readonly faults: FaultStore;
  nextSequence(scope: string): number;
}

export interface SandboxRegistry {
  create(sandbox: Sandbox): void;
  get(id: SandboxId): Sandbox | null;
  byAccessToken(token: string): Sandbox | null;
  byPublicKey(key: string): Sandbox | null;
  list(): readonly Sandbox[];
  reset(id: SandboxId): void;
  remove(id: SandboxId): void;
}

export type DocumentKind =
  | 'card_token'
  | 'preference'
  | 'merchant_order'
  | 'customer'
  | 'customer_card'
  | 'preapproval_plan'
  | 'preapproval'
  | 'authorized_payment'
  | 'order';

export interface StoredDocument {
  readonly kind: DocumentKind;
  readonly id: string;
  readonly sequence: number;
  readonly status: string;
  readonly externalReference: string | null;
  /** Secondary key for lookups that are not the id, e.g. a customer's email. */
  readonly lookup: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number | null;
  readonly doc: JsonObject;
}

export interface DocumentQuery {
  readonly status?: string;
  readonly externalReference?: string;
  readonly lookup?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly order?: 'asc' | 'desc';
}

export interface DocumentRepository {
  insert(document: StoredDocument): void;
  update(document: StoredDocument): void;
  get(kind: DocumentKind, id: string): StoredDocument | null;
  bySequence(kind: DocumentKind, sequence: number): StoredDocument | null;
  byLookup(kind: DocumentKind, lookup: string): StoredDocument | null;
  search(kind: DocumentKind, query: DocumentQuery): Page<StoredDocument>;
  remove(kind: DocumentKind, id: string): boolean;
  expired(kind: DocumentKind, at: number): readonly StoredDocument[];
}

export type DeliveryStatus = 'queued' | 'sending' | 'delivered' | 'retrying' | 'exhausted';

export interface WebhookAttempt {
  readonly seq: number;
  readonly at: number;
  readonly statusCode: number | null;
  readonly error: string | null;
  readonly durationMs: number;
}

export interface WebhookDelivery {
  readonly id: WebhookDeliveryId;
  readonly sandbox: SandboxId;
  readonly sequence: number;
  readonly event: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly url: string;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly requestHeaders: Record<string, string>;
  readonly requestBody: string;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  readonly responseBody: string | null;
  readonly nextAttemptAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WebhookRepository {
  insert(delivery: WebhookDelivery): void;
  update(delivery: WebhookDelivery): void;
  get(id: WebhookDeliveryId): WebhookDelivery | null;
  list(limit?: number): readonly WebhookDelivery[];
  attempts(id: WebhookDeliveryId): readonly WebhookAttempt[];
  recordAttempt(id: WebhookDeliveryId, attempt: Omit<WebhookAttempt, 'seq'>): void;
}

export interface FaultProfile {
  readonly latencyMs: number;
  readonly errorRate: number;
  readonly unavailable: boolean;
  readonly duplicateWebhooks: boolean;
  readonly webhookFailureRate: number;
}

export const NO_FAULTS: FaultProfile = {
  latencyMs: 0,
  errorRate: 0,
  unavailable: false,
  duplicateWebhooks: false,
  webhookFailureRate: 0,
};

export interface FaultStore {
  get(): FaultProfile;
  set(profile: FaultProfile): void;
}

/** Deliveries due across every sandbox, for the background runner. */
export interface DeliveryQueue {
  due(at: number, limit: number): readonly { sandbox: SandboxId; delivery: WebhookDelivery }[];
}
