import {
  type DeclineReason,
  type JsonObject,
  type JsonValue,
  type Minor,
  type PaymentDecision,
  type PaymentMethodKind,
  type Result,
  type StoredDocument,
  ZERO,
  err,
  fromDecimal,
  isJsonObject,
  ok,
} from '@payground/core';
import { type ErrorBody, badRequest, conflict, notFound, unprocessable } from '../errors.ts';
import type { OrderPayment, OrderPaymentMethod, OrderRequest } from '../generated/types.ts';
import { validateOrderRefundRequest, validateOrderRequest } from '../generated/validate.ts';
import { brCode } from '../pix/index.ts';
import { qrPng } from '../qr/index.ts';
import { formatDateTime } from '../serialize/datetime.ts';
import { consumeCardToken } from './card-tokens.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { decide } from './decision.ts';
import { PIX_DEFAULT_TTL_MS, VOUCHER_DEFAULT_TTL_MS } from './methods.ts';

/**
 * Orders API. Its status vocabulary is its own — `created / processed / processing /
 * action_required / in_review / charged_back / expired / refunded / failed / canceled`,
 * each with its own detail — and is not the Payments API vocabulary.
 * https://www.mercadopago.com.br/developers/en/docs/checkout-api-orders/payment-management/status/transaction-status
 */
export type OrderStatus =
  | 'created'
  | 'processed'
  | 'processing'
  | 'in_review'
  | 'action_required'
  | 'charged_back'
  | 'expired'
  | 'refunded'
  | 'failed'
  | 'canceled';

export interface OrderState {
  readonly status: OrderStatus;
  readonly detail: string;
}

const STATUSES: readonly string[] = [
  'created', 'processed', 'processing', 'in_review', 'action_required',
  'charged_back', 'expired', 'refunded', 'failed', 'canceled',
];

/** A transaction in one of these needs nothing further from anyone. */
const TERMINAL: readonly OrderStatus[] = ['processed', 'refunded', 'failed', 'expired', 'canceled', 'charged_back'];

const isTerminal = (status: OrderStatus): boolean => TERMINAL.includes(status);

/** Payment method families, keyed by the Orders API `payment_method.type`. */
const KINDS: Record<OrderPaymentMethod['type'], PaymentMethodKind> = {
  credit_card: 'card',
  debit_card: 'card',
  bank_transfer: 'bank_transfer',
  ticket: 'voucher',
  digital_wallet: 'wallet',
  account_money: 'wallet',
};

/**
 * Failure details the Orders API exposes, mapped from the domain decline reasons.
 * Every value here appears in `ORDER_TRANSACTION_STATUSES` (asserted in the tests).
 */
const FAILURE_DETAILS: Record<DeclineReason, string> = {
  insufficient_funds: 'card_insufficient_amount',
  invalid_security_code: 'bad_filled_card_data',
  expired_card: 'bad_filled_card_data',
  invalid_card_number: 'bad_filled_card_data',
  invalid_expiry_date: 'bad_filled_card_data',
  invalid_data: 'bad_filled_card_data',
  call_for_authorize: 'required_call_for_authorize',
  card_disabled: 'card_disabled',
  card_type_not_allowed: 'rejected_by_issuer',
  high_risk: 'high_risk',
  duplicate: 'rejected_by_issuer',
  blacklisted: 'high_risk',
  max_attempts: 'max_attempts_exceeded',
  invalid_installments: 'invalid_installments',
  bank_error: 'processing_error',
  timeout: 'processing_error',
  unsupported: 'processing_error',
  other: 'processing_error',
};

const MAX_INSTALLMENTS = 24;
const MAX_SEARCH_SCAN = 1_000;
const DEFAULT_SEARCH_LIMIT = 30;

// ---------------------------------------------------------------------------
// money — the Orders API carries every amount as a decimal string.
// ---------------------------------------------------------------------------

const AMOUNT_PATTERN = /^\d+(?:\.\d{1,2})?$/;

function parseAmount(value: string): Minor | null {
  if (!AMOUNT_PATTERN.test(value)) return null;
  const parsed = fromDecimal(Number(value));
  return parsed.ok ? parsed.value : null;
}

const formatAmount = (value: Minor): string => (value / 100).toFixed(2);

const plus = (a: Minor, b: Minor): Minor => (a + b) as Minor;
const total = (values: readonly Minor[]): Minor => values.reduce(plus, ZERO);

/** ISO-8601 duration, the form `expiration_time` uses (`P1D`, `PT30M`, `P1DT2H`). */
const DURATION_PATTERN = /^P(?!$)(?:(\d+)D)?(?:T(?!$)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

function parseDuration(value: string): number | null {
  const match = DURATION_PATTERN.exec(value);
  if (match === null) return null;
  const days = Number(match[1] ?? '0');
  const hours = Number(match[2] ?? '0');
  const minutes = Number(match[3] ?? '0');
  const seconds = Number(match[4] ?? '0');
  const ms = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000;
  return ms > 0 ? ms : null;
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

interface MethodRecord {
  id: string;
  type: OrderPaymentMethod['type'];
  token: string | null;
  installments: number;
  statementDescriptor: string | null;
}

interface TransactionRecord {
  id: string;
  referenceId: string;
  amount: Minor;
  paidAmount: Minor;
  status: OrderStatus;
  detail: string;
  method: MethodRecord;
  expiresAt: number | null;
}

interface RefundRecord {
  id: string;
  transactionId: string;
  amount: Minor;
  createdAt: number;
}

interface OrderRecord {
  id: string;
  sequence: number;
  processingMode: NonNullable<OrderRequest['processing_mode']>;
  captureMode: NonNullable<OrderRequest['capture_mode']>;
  status: OrderStatus;
  detail: string;
  totalAmount: Minor;
  externalReference: string | null;
  description: string | null;
  payer: JsonObject;
  items: JsonValue[] | null;
  shipment: JsonObject | null;
  config: JsonObject | null;
  payments: TransactionRecord[];
  refunds: RefundRecord[];
  createdAt: number;
  updatedAt: number;
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asObject = (value: unknown): JsonObject | null => (isJsonObject(value) ? value : null);
const asArray = (value: unknown): JsonValue[] | null => (Array.isArray(value) ? (value as JsonValue[]) : null);

const asStatus = (value: unknown): OrderStatus =>
  typeof value === 'string' && STATUSES.includes(value) ? (value as OrderStatus) : 'created';

const asAmount = (value: unknown): Minor => {
  const raw = asString(value);
  return (raw === null ? null : parseAmount(raw)) ?? ZERO;
};

const asInstant = (value: unknown): number | null => {
  const raw = asString(value);
  if (raw === null) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Ids are prefixed Crockford base32, the shape the Orders API returns (`ORD…`, `PAY…`,
 * `REF…`). Derived from the injected id generator, so a seeded run is reproducible.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function identifier(context: ServiceContext, prefix: string): string {
  let value = BigInt(`0x${context.ids.uuid().replaceAll('-', '')}`);
  let out = '';
  for (let index = 0; index < 26; index++) {
    out = (ALPHABET[Number(value % 32n)] ?? '0') + out;
    value /= 32n;
  }
  return prefix + out;
}

// ---------------------------------------------------------------------------
// status derivation
// ---------------------------------------------------------------------------

/**
 * The order status is a view over its transactions, never stored independently: while any
 * transaction still needs something, the order reports that transaction; once they are all
 * terminal the outcomes are folded together.
 */
export function deriveStatus(payments: readonly OrderState[]): OrderState {
  if (payments.length === 0) return { status: 'created', detail: 'created' };

  const active = payments.filter((payment) => payment.status !== 'canceled');
  if (active.length === 0) return { status: 'canceled', detail: 'canceled' };

  const pending = active.find((payment) => !isTerminal(payment.status));
  if (pending !== undefined) return { status: pending.status, detail: pending.detail };

  const chargedBack = active.find((payment) => payment.status === 'charged_back');
  if (chargedBack !== undefined) return { status: 'charged_back', detail: chargedBack.detail };

  const refunded = active.filter((payment) => payment.status === 'refunded');
  if (refunded.length === active.length) return { status: 'refunded', detail: 'refunded' };

  const processed = active.filter((payment) => payment.status === 'processed');
  if (processed.length > 0 || refunded.length > 0) {
    const partial = refunded.length > 0 || processed.some((payment) => payment.detail === 'partially_refunded');
    return { status: 'processed', detail: partial ? 'partially_refunded' : 'accredited' };
  }

  const failed = active.find((payment) => payment.status === 'failed');
  if (failed !== undefined) return { status: 'failed', detail: failed.detail };

  return { status: 'expired', detail: 'expired' };
}

function refresh(record: OrderRecord, now: number): void {
  const derived = deriveStatus(record.payments);
  record.status = derived.status;
  record.detail = derived.detail;
  record.updatedAt = now;
}

const paidTotal = (record: OrderRecord): Minor => total(record.payments.map((payment) => payment.paidAmount));

const refundedFor = (record: OrderRecord, transactionId: string): Minor =>
  total(record.refunds.filter((refund) => refund.transactionId === transactionId).map((refund) => refund.amount));

/** Only a transaction still waiting on the payer can expire. */
const awaitsPayer = (payment: TransactionRecord): boolean =>
  payment.status === 'action_required' &&
  (payment.detail === 'waiting_payment' || payment.detail === 'waiting_transfer');

function nextExpiry(record: OrderRecord): number | null {
  const deadlines = record.payments
    .filter((payment) => awaitsPayer(payment) && payment.expiresAt !== null)
    .map((payment) => payment.expiresAt as number);
  return deadlines.length === 0 ? null : Math.min(...deadlines);
}

// ---------------------------------------------------------------------------
// serialisation
// ---------------------------------------------------------------------------

const pixSettings = (context: ServiceContext) => ({
  key: `${context.sandbox.id}@payground.local`,
  merchantName: 'PAYGROUND SANDBOX',
  merchantCity: 'SAO PAULO',
});

/** Deterministic, exactly as for a Pix payment: the same order always yields the same code. */
function pixBlock(context: ServiceContext, record: OrderRecord, payment: TransactionRecord): JsonObject {
  const settings = pixSettings(context);
  const code = brCode({
    key: settings.key,
    merchantName: settings.merchantName,
    merchantCity: settings.merchantCity,
    amount: payment.amount / 100,
    txid: `PG${record.sequence}`,
    oneTime: true,
  });
  if (!code.ok) return {};
  const png = qrPng(code.value);
  if (!png.ok) return {};
  return {
    qr_code: code.value,
    qr_code_base64: Buffer.from(png.value).toString('base64'),
    ticket_url: `${context.baseUrl}/orders/${record.id}/transactions/${payment.id}/ticket`,
  };
}

function renderMethod(context: ServiceContext, record: OrderRecord, payment: TransactionRecord): JsonObject {
  const pix = payment.method.id === 'pix' && awaitsPayer(payment) ? pixBlock(context, record, payment) : {};
  const ticket =
    payment.method.type === 'ticket' && awaitsPayer(payment)
      ? { ticket_url: `${context.baseUrl}/orders/${record.id}/transactions/${payment.id}/ticket` }
      : {};

  return {
    id: payment.method.id,
    type: payment.method.type,
    ...(payment.method.token === null ? {} : { token: payment.method.token }),
    installments: payment.method.installments,
    ...(payment.method.statementDescriptor === null
      ? {}
      : { statement_descriptor: payment.method.statementDescriptor }),
    ...ticket,
    ...pix,
  };
}

function renderTransaction(
  context: ServiceContext,
  record: OrderRecord,
  payment: TransactionRecord,
): JsonObject {
  return {
    id: payment.id,
    reference_id: payment.referenceId,
    amount: formatAmount(payment.amount),
    paid_amount: formatAmount(payment.paidAmount),
    status: payment.status,
    status_detail: payment.detail,
    ...(payment.expiresAt === null ? {} : { date_of_expiration: formatDateTime(payment.expiresAt) }),
    payment_method: renderMethod(context, record, payment),
  };
}

const renderRefund = (refund: RefundRecord): JsonObject => ({
  id: refund.id,
  transaction_id: refund.transactionId,
  reference_id: refund.transactionId,
  amount: formatAmount(refund.amount),
  status: 'refunded',
  date_created: formatDateTime(refund.createdAt),
});

/**
 * The vendored `Order` schema stops at `transactions.payments`; the live API also returns
 * `transactions.refunds`, and its `status` enum omits the terminal values the transaction
 * table documents (`refunded`, `failed`, `expired`). We follow the API, not the enum.
 */
function renderOrder(context: ServiceContext, record: OrderRecord): JsonObject {
  return {
    id: record.id,
    type: 'online',
    processing_mode: record.processingMode,
    capture_mode: record.captureMode,
    status: record.status,
    status_detail: record.detail,
    ...(record.externalReference === null ? {} : { external_reference: record.externalReference }),
    total_amount: formatAmount(record.totalAmount),
    total_paid_amount: formatAmount(paidTotal(record)),
    ...(record.description === null ? {} : { description: record.description }),
    country_code: 'BRA',
    user_id: context.collectorId,
    created_date: formatDateTime(record.createdAt),
    last_updated_date: formatDateTime(record.updatedAt),
    payer: record.payer,
    ...(record.items === null ? {} : { items: record.items }),
    ...(record.shipment === null ? {} : { shipment: record.shipment }),
    ...(record.config === null ? {} : { config: record.config }),
    transactions: {
      payments: record.payments.map((payment) => renderTransaction(context, record, payment)),
      ...(record.refunds.length === 0 ? {} : { refunds: record.refunds.map(renderRefund) }),
    },
  };
}

function readMethod(value: JsonObject): MethodRecord {
  const type = asString(value['type']);
  const installments = value['installments'];
  return {
    id: asString(value['id']) ?? '',
    type: type !== null && type in KINDS ? (type as OrderPaymentMethod['type']) : 'account_money',
    token: asString(value['token']),
    installments: typeof installments === 'number' ? installments : 1,
    statementDescriptor: asString(value['statement_descriptor']),
  };
}

function readTransaction(value: JsonValue): TransactionRecord | null {
  const payment = asObject(value);
  if (payment === null) return null;
  const id = asString(payment['id']);
  if (id === null) return null;
  return {
    id,
    referenceId: asString(payment['reference_id']) ?? id,
    amount: asAmount(payment['amount']),
    paidAmount: asAmount(payment['paid_amount']),
    status: asStatus(payment['status']),
    detail: asString(payment['status_detail']) ?? 'created',
    method: readMethod(asObject(payment['payment_method']) ?? {}),
    expiresAt: asInstant(payment['date_of_expiration']),
  };
}

function readRefund(value: JsonValue): RefundRecord | null {
  const refund = asObject(value);
  if (refund === null) return null;
  const id = asString(refund['id']);
  const transactionId = asString(refund['transaction_id']);
  if (id === null || transactionId === null) return null;
  return {
    id,
    transactionId,
    amount: asAmount(refund['amount']),
    createdAt: asInstant(refund['date_created']) ?? 0,
  };
}

function readOrder(document: StoredDocument): OrderRecord {
  const doc = document.doc;
  const transactions = asObject(doc['transactions']) ?? {};
  const captureMode = asString(doc['capture_mode']);

  return {
    id: document.id,
    sequence: document.sequence,
    processingMode: doc['processing_mode'] === 'manual' ? 'manual' : 'automatic',
    captureMode:
      captureMode === 'manual' || captureMode === 'automatic_async' ? captureMode : 'automatic',
    status: asStatus(doc['status']),
    detail: asString(doc['status_detail']) ?? 'created',
    totalAmount: asAmount(doc['total_amount']),
    externalReference: document.externalReference,
    description: asString(doc['description']),
    payer: asObject(doc['payer']) ?? {},
    items: asArray(doc['items']),
    shipment: asObject(doc['shipment']),
    config: asObject(doc['config']),
    payments: (asArray(transactions['payments']) ?? [])
      .map(readTransaction)
      .filter((payment): payment is TransactionRecord => payment !== null),
    refunds: (asArray(transactions['refunds']) ?? [])
      .map(readRefund)
      .filter((refund): refund is RefundRecord => refund !== null),
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

const toDocument = (context: ServiceContext, record: OrderRecord): StoredDocument => ({
  kind: 'order',
  id: record.id,
  sequence: record.sequence,
  status: record.status,
  externalReference: record.externalReference,
  lookup: asString(record.payer['email']),
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  expiresAt: nextExpiry(record),
  doc: renderOrder(context, record),
});

/**
 * Orders have no `notification_url` of their own, and their notification topic is `orders`
 * rather than `payment`; `EventNotice` cannot express that today, so the topic is lost.
 */
function emit(context: ServiceContext, record: OrderRecord, action: string): void {
  context.events.emit({ type: 'payment', action, dataId: record.id, notificationUrl: null });
}

function commit(context: ServiceContext, record: OrderRecord, action: string): Rendered['body'] {
  const document = toDocument(context, record);
  context.store.documents.update(document);
  emit(context, record, action);
  return document.doc;
}

// ---------------------------------------------------------------------------
// processing
// ---------------------------------------------------------------------------

function stateFor(decision: PaymentDecision, kind: PaymentMethodKind): OrderState {
  switch (decision.kind) {
    case 'settle':
      return { status: 'processed', detail: 'accredited' };
    case 'authorize':
      return { status: 'action_required', detail: 'waiting_capture' };
    case 'pending':
      if (decision.reason === 'awaiting_challenge') {
        return { status: 'action_required', detail: 'pending_challenge' };
      }
      // A bank transfer waits for the transfer; an offline voucher waits for the payment.
      return {
        status: 'action_required',
        detail: kind === 'bank_transfer' ? 'waiting_transfer' : 'waiting_payment',
      };
    case 'review':
      return {
        status: 'processing',
        detail: decision.reason === 'manual_review' ? 'pending_review_manual' : 'in_process',
      };
    case 'decline':
      return { status: 'failed', detail: FAILURE_DETAILS[decision.reason] };
  }
}

function outcome(context: ServiceContext, record: OrderRecord, payment: TransactionRecord): OrderState {
  const kind = KINDS[payment.method.type];
  if (kind !== 'card') {
    return stateFor(decide({ method: { kind, code: payment.method.id, card: null }, capture: true, binaryMode: false }), kind);
  }

  if (payment.method.token === null) return { status: 'failed', detail: 'invalid_card_token' };
  const card = consumeCardToken(context, payment.method.token);
  if (!card.ok) return { status: 'failed', detail: 'invalid_card_token' };

  return stateFor(
    decide({
      method: { kind, code: payment.method.id, card: card.value.card },
      capture: record.captureMode !== 'manual',
      binaryMode: false,
    }),
    kind,
  );
}

/** Runs every transaction still in `created`; this is what `processing_mode` schedules. */
function settle(context: ServiceContext, record: OrderRecord, now: number): void {
  for (const payment of record.payments) {
    if (payment.status !== 'created') continue;
    const state = outcome(context, record, payment);
    payment.status = state.status;
    payment.detail = state.detail;
    payment.paidAmount = state.status === 'processed' ? payment.amount : ZERO;
    if (!awaitsPayer(payment)) payment.expiresAt = null;
  }
  refresh(record, now);
}

// ---------------------------------------------------------------------------
// request parsing
// ---------------------------------------------------------------------------

const schemaError = (issues: readonly { path: string; message: string }[]): ErrorBody =>
  badRequest(
    'invalid parameters',
    issues.map((issue) => ({ code: 2034, description: `${issue.path}: ${issue.message}` })),
  );

const invalid = (code: number, description: string): ErrorBody =>
  badRequest('invalid parameters', [{ code, description }]);

function expiryFor(payment: OrderPayment, kind: PaymentMethodKind, now: number): Result<number | null, ErrorBody> {
  if (payment.date_of_expiration !== undefined) {
    const parsed = Date.parse(payment.date_of_expiration);
    if (Number.isNaN(parsed)) return err(invalid(3005, 'date_of_expiration invalid'));
    return ok(parsed);
  }
  if (payment.expiration_time !== undefined) {
    const duration = parseDuration(payment.expiration_time);
    if (duration === null) return err(invalid(3005, 'expiration_time must be an ISO-8601 duration'));
    return ok(now + duration);
  }
  if (kind === 'bank_transfer') return ok(now + PIX_DEFAULT_TTL_MS);
  if (kind === 'voucher') return ok(now + VOUCHER_DEFAULT_TTL_MS);
  return ok(null);
}

function parsePayment(
  context: ServiceContext,
  payment: OrderPayment,
  now: number,
  index: number,
): Result<TransactionRecord, ErrorBody> {
  const amount = parseAmount(payment.amount);
  if (amount === null || amount === ZERO) {
    return err(invalid(3003, `transactions.payments[${index}].amount invalid`));
  }

  const method = payment.payment_method;
  const kind = KINDS[method.type];
  const installments = method.installments ?? 1;
  if (!Number.isInteger(installments) || installments < 1 || installments > MAX_INSTALLMENTS) {
    return err(invalid(3006, `installments must be an integer between 1 and ${MAX_INSTALLMENTS}`));
  }
  if (kind === 'card' && (method.token === undefined || method.token === '')) {
    return err(invalid(2062, `transactions.payments[${index}].payment_method.token is required for cards`));
  }

  const expiresAt = expiryFor(payment, kind, now);
  if (!expiresAt.ok) return expiresAt;

  const id = identifier(context, 'PAY');
  return ok({
    id,
    referenceId: String(context.store.nextSequence('order_transaction')),
    amount,
    paidAmount: ZERO,
    status: 'created',
    detail: 'created',
    method: {
      id: method.id,
      type: method.type,
      token: method.token ?? null,
      installments,
      statementDescriptor: method.statement_descriptor ?? null,
    },
    expiresAt: expiresAt.value,
  });
}

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

export function createOrder(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  const now = context.clock.now();
  const validated = validateOrderRequest(body);
  if (!validated.ok) return err(schemaError(validated.error));
  const request = validated.value;

  const totalAmount = parseAmount(request.total_amount);
  if (totalAmount === null || totalAmount === ZERO) return err(invalid(3003, 'total_amount invalid'));

  const requested = request.transactions.payments ?? [];
  if (requested.length === 0) {
    return err(invalid(2034, 'transactions.payments must contain at least one payment'));
  }

  const payments: TransactionRecord[] = [];
  for (const [index, payment] of requested.entries()) {
    const parsed = parsePayment(context, payment, now, index);
    if (!parsed.ok) return parsed;
    payments.push(parsed.value);
  }

  if (total(payments.map((payment) => payment.amount)) !== totalAmount) {
    return err(invalid(2034, 'the sum of the transaction amounts must equal total_amount'));
  }

  const record: OrderRecord = {
    id: identifier(context, 'ORD'),
    sequence: context.store.nextSequence('order'),
    processingMode: request.processing_mode ?? 'automatic',
    captureMode: request.capture_mode ?? 'automatic',
    status: 'created',
    detail: 'created',
    totalAmount,
    externalReference: request.external_reference ?? null,
    description: request.description ?? null,
    payer: JSON.parse(JSON.stringify(request.payer)) as JsonObject,
    items: request.items === undefined ? null : (JSON.parse(JSON.stringify(request.items)) as JsonValue[]),
    shipment: request.shipment === undefined ? null : (JSON.parse(JSON.stringify(request.shipment)) as JsonObject),
    config: request.config === undefined ? null : (JSON.parse(JSON.stringify(request.config)) as JsonObject),
    payments,
    refunds: [],
    createdAt: now,
    updatedAt: now,
  };

  if (record.processingMode === 'automatic') settle(context, record, now);
  else refresh(record, now);

  const document = toDocument(context, record);
  context.store.documents.insert(document);
  emit(context, record, 'order.created');

  return ok({ status: 201, body: document.doc });
}

/** Expiry is applied on read, so a GET is correct even if no write has happened since. */
function materialize(context: ServiceContext, record: OrderRecord): OrderRecord {
  const now = context.clock.now();
  const expired = record.payments.filter(
    (payment) => awaitsPayer(payment) && payment.expiresAt !== null && now >= payment.expiresAt,
  );
  if (expired.length === 0) return record;

  for (const payment of expired) {
    payment.status = 'expired';
    payment.detail = 'expired';
  }
  refresh(record, now);
  commit(context, record, 'order.updated');
  return record;
}

function locate(context: ServiceContext, id: string): Result<OrderRecord, ErrorBody> {
  const document = context.store.documents.get('order', id);
  if (document === null) return err(notFound('Order not found'));
  return ok(materialize(context, readOrder(document)));
}

export function getOrder(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const record = locate(context, id);
  if (!record.ok) return record;
  return ok({ status: 200, body: renderOrder(context, record.value) });
}

function integerParam(params: URLSearchParams, name: string, fallback: number): Result<number, ErrorBody> {
  const raw = params.get(name);
  if (raw === null) return ok(fallback);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return err(invalid(2034, `${name} invalid`));
  return ok(parsed);
}

function instantParam(params: URLSearchParams, name: string): Result<number | null, ErrorBody> {
  const raw = params.get(name);
  if (raw === null) return ok(null);
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return err(invalid(2034, `${name} invalid`));
  return ok(parsed);
}

export function searchOrders(context: ServiceContext, params: URLSearchParams): Result<Rendered, ErrorBody> {
  const limit = integerParam(params, 'limit', DEFAULT_SEARCH_LIMIT);
  if (!limit.ok) return limit;
  const offset = integerParam(params, 'offset', 0);
  if (!offset.ok) return offset;
  const begin = instantParam(params, 'begin_date');
  if (!begin.ok) return begin;
  const end = instantParam(params, 'end_date');
  if (!end.ok) return end;

  const status = params.get('status');
  const externalReference = params.get('external_reference');
  const type = params.get('type');

  // The document store cannot filter on a date range, so the window is applied here; a
  // sandbox never holds enough orders for the scan cap to bite.
  const page = context.store.documents.search('order', {
    ...(status === null ? {} : { status }),
    ...(externalReference === null ? {} : { externalReference }),
    limit: MAX_SEARCH_SCAN,
    offset: 0,
    order: 'desc',
  });

  const matched = page.results
    .map((document) => materialize(context, readOrder(document)))
    .filter((record) => begin.value === null || record.createdAt >= begin.value)
    .filter((record) => end.value === null || record.createdAt <= end.value)
    .filter(() => type === null || type === 'online');

  const window = matched.slice(offset.value, offset.value + limit.value);

  return ok({
    status: 200,
    body: {
      data: window.map((record) => renderOrder(context, record)),
      paging: { total: matched.length, limit: limit.value, offset: offset.value },
    },
  });
}

/** The endpoints below take no body; a non-object body is still rejected, as the API does. */
function emptyBody(body: unknown): Result<JsonObject, ErrorBody> {
  if (body === undefined || body === null) return ok({});
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));
  return ok(body);
}

export function processOrder(context: ServiceContext, id: string, body: unknown): Result<Rendered, ErrorBody> {
  const parsed = emptyBody(body);
  if (!parsed.ok) return parsed;
  const located = locate(context, id);
  if (!located.ok) return located;
  const record = located.value;

  if (record.processingMode !== 'manual') {
    return err(conflict('only an order with processing_mode manual can be processed'));
  }
  if (!record.payments.some((payment) => payment.status === 'created')) {
    return err(conflict('the order has already been processed'));
  }

  settle(context, record, context.clock.now());
  return ok({ status: 200, body: commit(context, record, 'order.updated') });
}

/** `{ transactions: { payments: [{ id, amount }] } }`, the shape the capture endpoint takes. */
function requestedAmounts(body: unknown, field: 'transactions'): Result<Map<string, string>, ErrorBody> {
  const parsed = emptyBody(body);
  if (!parsed.ok) return parsed;
  const transactions = asObject(parsed.value[field]);
  const payments = transactions === null ? null : asArray(transactions['payments']);
  const out = new Map<string, string>();
  if (payments === null) return ok(out);

  for (const entry of payments) {
    const payment = asObject(entry);
    if (payment === null) return err(invalid(2034, 'transactions.payments entries must be objects'));
    const id = asString(payment['id']);
    const amount = asString(payment['amount']);
    if (id === null) return err(invalid(2034, 'transactions.payments[].id is required'));
    if (amount !== null) out.set(id, amount);
    else out.set(id, '');
  }
  return ok(out);
}

export function captureOrder(context: ServiceContext, id: string, body: unknown): Result<Rendered, ErrorBody> {
  const requested = requestedAmounts(body, 'transactions');
  if (!requested.ok) return requested;
  const located = locate(context, id);
  if (!located.ok) return located;
  const record = located.value;

  if (record.captureMode !== 'manual') {
    return err(conflict('only an order with capture_mode manual can be captured'));
  }

  const capturable = record.payments.filter(
    (payment) => payment.status === 'action_required' && payment.detail === 'waiting_capture',
  );
  if (capturable.length === 0) return err(conflict('no transaction is waiting for capture'));

  const single = asObject(body === undefined || body === null ? {} : body)?.['amount'];
  const bare = typeof single === 'string' && capturable.length === 1 ? single : null;

  for (const target of requested.value.keys()) {
    if (!capturable.some((payment) => payment.id === target)) return err(notFound('Transaction not found'));
  }

  for (const payment of capturable) {
    if (requested.value.size > 0 && !requested.value.has(payment.id)) continue;
    const raw = requested.value.get(payment.id) ?? bare ?? '';

    let amount = payment.amount;
    if (raw !== '') {
      const parsed = parseAmount(raw);
      if (parsed === null || parsed === ZERO) return err(invalid(3003, 'amount invalid'));
      if (parsed > payment.amount) return err(invalid(3003, 'amount exceeds the authorized amount'));
      amount = parsed;
    }

    // A partial capture keeps the authorized amount and settles only what was captured.
    payment.status = 'processed';
    payment.detail = 'accredited';
    payment.paidAmount = amount;
    payment.expiresAt = null;
  }

  refresh(record, context.clock.now());
  return ok({ status: 200, body: commit(context, record, 'order.updated') });
}

export function cancelOrder(context: ServiceContext, id: string, body: unknown): Result<Rendered, ErrorBody> {
  const parsed = emptyBody(body);
  if (!parsed.ok) return parsed;
  const located = locate(context, id);
  if (!located.ok) return located;
  const record = located.value;

  if (record.payments.some((payment) => payment.status === 'processed' || payment.status === 'refunded')) {
    return err(conflict('an order with a processed transaction cannot be canceled'));
  }
  const open = record.payments.filter((payment) => !isTerminal(payment.status));
  if (open.length === 0) return err(conflict('the order has no transaction that can be canceled'));

  for (const payment of open) {
    payment.status = 'canceled';
    payment.detail = 'canceled';
    payment.expiresAt = null;
  }

  refresh(record, context.clock.now());
  return ok({ status: 200, body: commit(context, record, 'order.updated') });
}

export function refundOrder(context: ServiceContext, id: string, body: unknown): Result<Rendered, ErrorBody> {
  const parsed = emptyBody(body);
  if (!parsed.ok) return parsed;
  const validated = validateOrderRefundRequest(parsed.value);
  if (!validated.ok) return err(schemaError(validated.error));
  const requested = validated.value.transactions ?? [];

  const located = locate(context, id);
  if (!located.ok) return located;
  const record = located.value;
  const now = context.clock.now();

  const settled = record.payments.filter((payment) => payment.status === 'processed');
  if (settled.length === 0) return err(conflict('the order has no processed transaction to refund'));

  const targets: { payment: TransactionRecord; amount: Minor }[] = [];
  if (requested.length === 0) {
    for (const payment of settled) {
      targets.push({ payment, amount: (payment.paidAmount - refundedFor(record, payment.id)) as Minor });
    }
  } else {
    for (const entry of requested) {
      const payment = settled.find((candidate) => candidate.id === entry.id);
      if (payment === undefined) return err(notFound('Transaction not found'));
      const remaining = (payment.paidAmount - refundedFor(record, payment.id)) as Minor;
      const amount = entry.amount === undefined ? remaining : parseAmount(entry.amount);
      if (amount === null || amount === ZERO) return err(invalid(3003, 'amount invalid'));
      if (amount > remaining) return err(invalid(2063, 'amount exceeds the refundable amount'));
      targets.push({ payment, amount });
    }
  }

  if (targets.every((target) => target.amount === ZERO)) {
    return err(conflict('the order is already fully refunded'));
  }

  for (const target of targets) {
    if (target.amount === ZERO) continue;
    record.refunds.push({
      id: identifier(context, 'REF'),
      transactionId: target.payment.id,
      amount: target.amount,
      createdAt: now,
    });
    const refunded = refundedFor(record, target.payment.id);
    if (refunded >= target.payment.paidAmount) {
      target.payment.status = 'refunded';
      target.payment.detail = 'refunded';
    } else {
      target.payment.detail = 'partially_refunded';
    }
  }

  refresh(record, now);
  return ok({ status: 201, body: commit(context, record, 'order.updated') });
}

// ---------------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------------

const notEditable = (): ErrorBody =>
  unprocessable('operation not allowed', [
    { code: 4051, description: 'only a transaction in status created can be modified' },
  ]);

function payloadPayments(body: unknown): Result<{ payments: OrderPayment[]; wrapped: boolean }, ErrorBody> {
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));
  const wrapped = body['payments'] !== undefined;
  const issues: { path: string; message: string }[] = [];
  const value = wrapped ? { payments: body['payments'] } : { payments: [body] };
  checkPayments(value.payments, issues);
  if (issues.length > 0) return err(schemaError(issues));
  return ok({ payments: value.payments as unknown as OrderPayment[], wrapped });
}

function checkPayments(value: JsonValue | undefined, issues: { path: string; message: string }[]): void {
  const payments = asArray(value);
  if (payments === null || payments.length === 0) {
    issues.push({ path: 'payments', message: 'expected a non-empty array' });
    return;
  }
  for (const [index, entry] of payments.entries()) {
    const payment = asObject(entry);
    if (payment === null) {
      issues.push({ path: `payments[${index}]`, message: 'expected object' });
      continue;
    }
    if (typeof payment['amount'] !== 'string') {
      issues.push({ path: `payments[${index}].amount`, message: 'expected string' });
    }
    const method = asObject(payment['payment_method']);
    if (method === null) {
      issues.push({ path: `payments[${index}].payment_method`, message: 'expected object' });
      continue;
    }
    if (typeof method['id'] !== 'string') {
      issues.push({ path: `payments[${index}].payment_method.id`, message: 'expected string' });
    }
    const type = method['type'];
    if (typeof type !== 'string' || !(type in KINDS)) {
      issues.push({ path: `payments[${index}].payment_method.type`, message: 'not one of the allowed values' });
    }
  }
}

export function addTransaction(context: ServiceContext, id: string, body: unknown): Result<Rendered, ErrorBody> {
  const payload = payloadPayments(body);
  if (!payload.ok) return payload;

  const located = locate(context, id);
  if (!located.ok) return located;
  const record = located.value;
  const now = context.clock.now();

  if (record.status !== 'created') {
    return err(
      unprocessable('operation not allowed', [
        { code: 4051, description: 'transactions can only be added while the order is in status created' },
      ]),
    );
  }

  const added: TransactionRecord[] = [];
  for (const [index, payment] of payload.value.payments.entries()) {
    const parsed = parsePayment(context, payment, now, index);
    if (!parsed.ok) return parsed;
    added.push(parsed.value);
  }

  const committed = total([...record.payments, ...added].map((payment) => payment.amount));
  if (committed > record.totalAmount) {
    return err(
      unprocessable('operation not allowed', [
        { code: 4051, description: 'the transaction amounts would exceed total_amount' },
      ]),
    );
  }

  record.payments.push(...added);
  refresh(record, now);
  commit(context, record, 'order.updated');

  const rendered = added.map((payment) => renderTransaction(context, record, payment));
  return ok({ status: 201, body: payload.value.wrapped ? { payments: rendered } : rendered[0] });
}

export function updateTransaction(
  context: ServiceContext,
  id: string,
  transactionId: string,
  body: unknown,
): Result<Rendered, ErrorBody> {
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));

  const located = locate(context, id);
  if (!located.ok) return located;
  const record = located.value;
  const payment = record.payments.find((candidate) => candidate.id === transactionId);
  if (payment === undefined) return err(notFound('Transaction not found'));
  if (payment.status !== 'created') return err(notEditable());

  const rawAmount = body['amount'];
  if (rawAmount !== undefined) {
    if (typeof rawAmount !== 'string') return err(invalid(2034, 'amount: expected string'));
    const amount = parseAmount(rawAmount);
    if (amount === null || amount === ZERO) return err(invalid(3003, 'amount invalid'));
    const others = record.payments.filter((candidate) => candidate.id !== transactionId);
    if (total([...others.map((candidate) => candidate.amount), amount]) > record.totalAmount) {
      return err(
        unprocessable('operation not allowed', [
          { code: 4051, description: 'the transaction amounts would exceed total_amount' },
        ]),
      );
    }
    payment.amount = amount;
  }

  const method = body['payment_method'];
  if (method !== undefined) {
    const patch = asObject(method);
    if (patch === null) return err(invalid(2034, 'payment_method: expected object'));

    const type = patch['type'];
    if (type !== undefined) {
      if (typeof type !== 'string' || !(type in KINDS)) {
        return err(invalid(2034, 'payment_method.type: not one of the allowed values'));
      }
      payment.method.type = type as OrderPaymentMethod['type'];
    }
    const methodId = patch['id'];
    if (methodId !== undefined) {
      if (typeof methodId !== 'string') return err(invalid(2034, 'payment_method.id: expected string'));
      payment.method.id = methodId;
    }
    const token = patch['token'];
    if (token !== undefined) {
      if (typeof token !== 'string') return err(invalid(2034, 'payment_method.token: expected string'));
      payment.method.token = token;
    }
    const installments = patch['installments'];
    if (installments !== undefined) {
      if (!Number.isInteger(installments) || (installments as number) < 1 || (installments as number) > MAX_INSTALLMENTS) {
        return err(invalid(3006, `installments must be an integer between 1 and ${MAX_INSTALLMENTS}`));
      }
      payment.method.installments = installments as number;
    }
    if (KINDS[payment.method.type] === 'card' && payment.method.token === null) {
      return err(invalid(2062, 'payment_method.token is required for cards'));
    }
  }

  refresh(record, context.clock.now());
  commit(context, record, 'order.updated');
  return ok({ status: 200, body: renderTransaction(context, record, payment) });
}

export function deleteTransaction(
  context: ServiceContext,
  id: string,
  transactionId: string,
): Result<Rendered, ErrorBody> {
  const located = locate(context, id);
  if (!located.ok) return located;
  const record = located.value;

  const index = record.payments.findIndex((candidate) => candidate.id === transactionId);
  const payment = record.payments[index];
  if (payment === undefined) return err(notFound('Transaction not found'));
  if (payment.status !== 'created') return err(notEditable());

  record.payments.splice(index, 1);
  refresh(record, context.clock.now());
  commit(context, record, 'order.updated');

  // 204: the handler serialises `undefined` to an empty body.
  return ok({ status: 204, body: undefined });
}
