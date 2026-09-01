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
  rename(id: SandboxId, name: string): boolean;
  reset(id: SandboxId): void;
  remove(id: SandboxId): void;
}

export type DocumentKind =
  | 'card_token'
  | 'preference'
  | 'merchant_order'
  | 'customer'
  | 'customer_card'
  | 'customer_address'
  | 'preapproval_plan'
  | 'preapproval'
  | 'authorized_payment'
  | 'order'
  | 'advanced_payment'
  | 'chargeback'
  | 'store'
  | 'pos'
  | 'terminal'
  | 'point_intent'
  | 'qr_order'
  | 'qr_config'
  | 'wallet_agreement'
  | 'payout'
  | 'transaction_intent'
  | 'claim'
  | 'claim_message'
  | 'report'
  | 'report_config'
  | 'report_task';

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
  /** Free text matched against the id, the lookup key and the document body. */
  readonly text?: string;
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
  /** Document counts per kind, without loading the documents themselves. */
  countByKind(): Readonly<Record<string, number>>;
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
  /** Delivery counts per status, without loading the deliveries themselves. */
  countByStatus(): Readonly<Record<string, number>>;
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

/** Counters and latency samples. Aggregation lives in the adapter, not the domain. */
export interface MetricsSink {
  count(name: string, labels: Readonly<Record<string, string>>, delta?: number): void;
  observe(name: string, labels: Readonly<Record<string, string>>, value: number): void;
}

export const noopMetrics: MetricsSink = { count: () => undefined, observe: () => undefined };

export type AuditActor =
  | { readonly kind: 'admin' }
  | { readonly kind: 'sandbox'; readonly sandbox: SandboxId }
  | { readonly kind: 'system' };

export interface AuditEntry {
  readonly id: string;
  readonly at: number;
  readonly actor: AuditActor;
  readonly action: string;
  readonly target: string;
  readonly sandbox: SandboxId | null;
  readonly detail: JsonObject;
}

export interface AuditQuery {
  readonly sandbox?: SandboxId;
  readonly action?: string;
  readonly from?: number;
  readonly to?: number;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AuditLog {
  record(entry: AuditEntry): void;
  search(query: AuditQuery): Page<AuditEntry>;
  purgeBefore(cutoff: number): number;
}

export const noopAudit: AuditLog = {
  record: () => undefined,
  search: () => ({ total: 0, limit: 0, offset: 0, results: [] }),
  purgeBefore: () => 0,
};

export interface ApiRequestEntry {
  readonly id: string;
  readonly at: number;
  readonly sandbox: SandboxId | null;
  readonly method: string;
  readonly route: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly requestBody: string | null;
  readonly responseBody: string | null;
  readonly idempotencyKey: string | null;
  readonly userAgent: string | null;
}

export interface ApiRequestQuery {
  readonly sandbox?: SandboxId;
  readonly route?: string;
  readonly method?: string;
  readonly status?: number;
  readonly minStatus?: number;
  readonly from?: number;
  readonly to?: number;
  readonly limit?: number;
  readonly offset?: number;
}

/** Every call the emulator answered, so an integrator can replay and diff it later. */
export interface ApiRequestLog {
  record(entry: ApiRequestEntry): void;
  get(id: string): ApiRequestEntry | null;
  search(query: ApiRequestQuery): Page<ApiRequestEntry>;
  purgeBefore(cutoff: number): number;
}

export const noopRequestLog: ApiRequestLog = {
  record: () => undefined,
  get: () => null,
  search: () => ({ total: 0, limit: 0, offset: 0, results: [] }),
  purgeBefore: () => 0,
};

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

export interface RateLimiter {
  take(key: string, now: number): RateLimitDecision;
}

export const noopRateLimiter: RateLimiter = {
  take: () => ({ allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterMs: 0 }),
};
