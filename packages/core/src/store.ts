import type { PaymentId, RefundId, SandboxId } from './ids.ts';
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
