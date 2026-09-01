import {
  type JsonObject,
  type JsonValue,
  type Minor,
  type Result,
  type StoredDocument,
  ZERO,
  err,
  fromDecimal,
  isJsonObject,
  ok,
  toDecimal,
} from '@payground/core';
import { type ErrorBody, badRequest, errorBody, notFound } from '../errors.ts';
import { formatDateTime } from '../serialize/datetime.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { readNumber, readObject, readObjects, readString } from './document.ts';
import { createPayment, getPayment } from './payments.ts';

/**
 * Payouts API: a batch of outbound transfers, each settled on its own.
 * https://www.mercadopago.com.br/developers/en/reference/payouts/_payouts/post
 */
export type PayoutTransactionStatus = 'pending' | 'processed' | 'cancelled' | 'failed';
export type PayoutStatus = PayoutTransactionStatus | 'partially_processed';

export interface PayoutState {
  readonly status: PayoutTransactionStatus;
  readonly detail: string;
}

export interface PayoutBatchState {
  readonly status: PayoutStatus;
  readonly detail: string;
}

const TRANSACTION_STATUSES: readonly string[] = ['pending', 'processed', 'cancelled', 'failed'];

const DEFAULT_LIMIT = 30;

/** A TED reaches the receiving bank on the next business day; Pix is instant. */
const TED_SETTLEMENT_MS = 24 * 60 * 60 * 1000;

/**
 * The batch status is a view over its transactions, never stored independently: while any
 * transfer is still on its way the batch is pending, and once they are all terminal the
 * outcomes fold together.
 */
export function deriveStatus(transactions: readonly PayoutState[]): PayoutBatchState {
  if (transactions.length === 0) return { status: 'pending', detail: 'pending' };

  const pending = transactions.find((transaction) => transaction.status === 'pending');
  if (pending !== undefined) return { status: 'pending', detail: pending.detail };

  const processed = transactions.filter((transaction) => transaction.status === 'processed');
  if (processed.length === transactions.length) return { status: 'processed', detail: 'accredited' };
  if (processed.length > 0) return { status: 'partially_processed', detail: 'partially_processed' };

  const failed = transactions.find((transaction) => transaction.status === 'failed');
  if (failed !== undefined) return { status: 'failed', detail: failed.detail };

  const cancelled = transactions.find((transaction) => transaction.status === 'cancelled');
  return { status: 'cancelled', detail: cancelled?.detail ?? 'cancelled' };
}

// ---------------------------------------------------------------------------
// money and receivers
// ---------------------------------------------------------------------------

const invalid = (code: number, description: string): ErrorBody =>
  badRequest('invalid parameters', [{ code, description }]);

function parseAmount(value: JsonValue | undefined): Minor | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const parsed = fromDecimal(value);
  if (!parsed.ok || parsed.value <= ZERO) return null;
  return parsed.value;
}

const plus = (a: Minor, b: Minor): Minor => (a + b) as Minor;

/** The four Pix key forms: email, phone in E.164, CPF/CNPJ and a random (EVP) uuid. */
const PIX_KEYS: readonly RegExp[] = [
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  /^\+55\d{10,11}$/,
  /^\d{11}$|^\d{14}$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
];

const BANK_CODE = /^\d{3}$/;
const BRANCH = /^\d{1,5}$/;
const ACCOUNT = /^[\dxX-]{3,20}$/;
const DOCUMENT = /^\d{11}$|^\d{14}$/;

const BANK_FIELDS: readonly string[] = ['bank_code', 'branch', 'account', 'document'];

function parseReceiver(value: JsonValue | undefined, path: string): Result<JsonObject, ErrorBody> {
  if (!isJsonObject(value)) return err(invalid(2034, `${path} is required`));
  if (typeof value['pix_key'] === 'string') return ok(value);

  const missing = BANK_FIELDS.filter((field) => typeof value[field] !== 'string');
  if (missing.length > 0) {
    return err(invalid(2034, `${path} needs a pix_key or ${missing.join(', ')}`));
  }
  return ok(value);
}

const field = (receiver: JsonObject, name: string): string => readString(receiver, name) ?? '';

/**
 * Pix settles on creation; a TED stays pending until its release date, so it can still be
 * cancelled. A key or account that no bank would accept is taken by the API and fails
 * afterwards, not at request time.
 */
function outcome(receiver: JsonObject, now: number): PayoutState & { releaseAt: number | null } {
  const pixKey = readString(receiver, 'pix_key');
  if (pixKey !== null) {
    return PIX_KEYS.some((pattern) => pattern.test(pixKey))
      ? { status: 'processed', detail: 'accredited', releaseAt: now }
      : { status: 'failed', detail: 'invalid_pix_key', releaseAt: null };
  }
  const valid =
    BANK_CODE.test(field(receiver, 'bank_code')) &&
    BRANCH.test(field(receiver, 'branch')) &&
    ACCOUNT.test(field(receiver, 'account')) &&
    DOCUMENT.test(field(receiver, 'document'));
  return valid
    ? { status: 'pending', detail: 'pending_transfer', releaseAt: now + TED_SETTLEMENT_MS }
    : { status: 'failed', detail: 'invalid_bank_account', releaseAt: null };
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

interface TransactionRecord extends PayoutState {
  id: string;
  amount: Minor;
  receiver: JsonObject;
  releaseAt: number | null;
}

interface PayoutRecord {
  id: string;
  sequence: number;
  externalReference: string | null;
  currencyId: string;
  totalAmount: Minor;
  transactions: TransactionRecord[];
  createdAt: number;
  updatedAt: number;
}

const renderTransaction = (transaction: TransactionRecord): JsonObject => ({
  id: transaction.id,
  amount: toDecimal(transaction.amount),
  status: transaction.status,
  status_detail: transaction.detail,
  receiver: transaction.receiver,
  ...(transaction.releaseAt === null ? {} : { money_release_date: formatDateTime(transaction.releaseAt) }),
});

function renderPayout(record: PayoutRecord): JsonObject {
  const state = deriveStatus(record.transactions);
  return {
    id: record.id,
    ...(record.externalReference === null ? {} : { external_reference: record.externalReference }),
    currency_id: record.currencyId,
    total_amount: toDecimal(record.totalAmount),
    status: state.status,
    status_detail: state.detail,
    transactions: record.transactions.map(renderTransaction),
    date_created: formatDateTime(record.createdAt),
    date_last_updated: formatDateTime(record.updatedAt),
  };
}

const toMinor = (value: number | null): Minor => {
  const parsed = fromDecimal(value ?? 0);
  return parsed.ok ? parsed.value : ZERO;
};

function readTransaction(doc: JsonObject): TransactionRecord {
  const status = readString(doc, 'status');
  const releaseAt = Date.parse(readString(doc, 'money_release_date') ?? '');
  return {
    releaseAt: Number.isNaN(releaseAt) ? null : releaseAt,
    id: readString(doc, 'id') ?? '',
    amount: toMinor(readNumber(doc, 'amount')),
    status: TRANSACTION_STATUSES.includes(status ?? '') ? (status as PayoutTransactionStatus) : 'pending',
    detail: readString(doc, 'status_detail') ?? 'pending',
    receiver: readObject(doc, 'receiver'),
  };
}

const readPayout = (document: StoredDocument): PayoutRecord => ({
  id: document.id,
  sequence: document.sequence,
  externalReference: document.externalReference,
  currencyId: readString(document.doc, 'currency_id') ?? 'BRL',
  totalAmount: toMinor(readNumber(document.doc, 'total_amount')),
  transactions: readObjects(document.doc, 'transactions').map(readTransaction),
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
});

const toDocument = (record: PayoutRecord): StoredDocument => ({
  kind: 'payout',
  id: record.id,
  sequence: record.sequence,
  status: deriveStatus(record.transactions).status,
  externalReference: record.externalReference,
  lookup: null,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  expiresAt: null,
  doc: renderPayout(record),
});

/** `EventNotice` has no payout topic, so the notice rides the payment topic, as orders do. */
const emit = (context: ServiceContext, id: string, action: string): void => {
  context.events.emit({ type: 'payment', action, dataId: id, notificationUrl: null });
};

// ---------------------------------------------------------------------------
// payouts
// ---------------------------------------------------------------------------

export function createPayout(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));

  const currencyId = readString(body, 'currency_id') ?? 'BRL';
  if (currencyId !== 'BRL') return err(invalid(3005, 'currency_id must be BRL'));

  const totalAmount = parseAmount(body['total_amount']);
  if (totalAmount === null) return err(invalid(3003, 'total_amount invalid'));

  const entries = body['transactions'];
  if (!Array.isArray(entries) || entries.length === 0) {
    return err(invalid(2034, 'transactions must be a non-empty array'));
  }

  const now = context.clock.now();
  const transactions: TransactionRecord[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!isJsonObject(entry)) return err(invalid(2034, `transactions[${index}] must be an object`));
    const amount = parseAmount(entry['amount']);
    if (amount === null) return err(invalid(3003, `transactions[${index}].amount invalid`));
    const receiver = parseReceiver(entry['receiver'], `transactions[${index}].receiver`);
    if (!receiver.ok) return receiver;

    transactions.push({
      id: context.ids.uuid(),
      amount,
      receiver: receiver.value,
      ...outcome(receiver.value, now),
    });
  }

  const sum = transactions.map((transaction) => transaction.amount).reduce(plus, ZERO);
  if (sum !== totalAmount) {
    return err(invalid(2034, 'the sum of the transaction amounts must equal total_amount'));
  }

  const document = toDocument({
    id: context.ids.uuid(),
    sequence: context.store.nextSequence('payout'),
    externalReference: readString(body, 'external_reference'),
    currencyId,
    totalAmount,
    transactions,
    createdAt: now,
    updatedAt: now,
  });

  context.store.documents.insert(document);
  emit(context, document.id, 'payout.created');
  return ok({ status: 201, body: document.doc });
}

/** Settlement is applied on read, so a GET is correct even if no write has happened since. */
function materialize(context: ServiceContext, record: PayoutRecord): PayoutRecord {
  const now = context.clock.now();
  const due = record.transactions.filter(
    (transaction) =>
      transaction.status === 'pending' && transaction.releaseAt !== null && now >= transaction.releaseAt,
  );
  if (due.length === 0) return record;

  record.transactions = record.transactions.map((transaction) =>
    due.includes(transaction) ? { ...transaction, status: 'processed', detail: 'accredited' } : transaction,
  );
  record.updatedAt = now;
  context.store.documents.update(toDocument(record));
  emit(context, record.id, 'payout.updated');
  return record;
}

function locate(context: ServiceContext, id: string): Result<PayoutRecord, ErrorBody> {
  const document = context.store.documents.get('payout', id);
  if (document === null) return err(notFound('Payout not found'));
  return ok(materialize(context, readPayout(document)));
}

function integerParam(params: URLSearchParams, name: string, fallback: number): Result<number, ErrorBody> {
  const raw = params.get(name);
  if (raw === null) return ok(fallback);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return err(invalid(2034, `${name} invalid`));
  return ok(parsed);
}

export function listPayoutTransactions(
  context: ServiceContext,
  payoutId: string,
  params: URLSearchParams,
): Result<Rendered, ErrorBody> {
  const limit = integerParam(params, 'limit', DEFAULT_LIMIT);
  if (!limit.ok) return limit;
  const offset = integerParam(params, 'offset', 0);
  if (!offset.ok) return offset;

  const located = locate(context, payoutId);
  if (!located.ok) return located;

  const status = params.get('status');
  const matched = located.value.transactions.filter(
    (transaction) => status === null || transaction.status === status,
  );
  const window = matched.slice(offset.value, offset.value + limit.value);

  return ok({
    status: 200,
    body: {
      paging: { total: matched.length, limit: limit.value, offset: offset.value },
      results: window.map(renderTransaction),
    },
  });
}

const notCancellable = (status: PayoutTransactionStatus): ErrorBody =>
  errorBody(409, 'conflict', 'operation not allowed', [
    { code: 4051, description: `a transaction in status ${status} cannot be cancelled` },
  ]);

export function cancelPayoutTransaction(
  context: ServiceContext,
  payoutId: string,
  transactionId: string,
): Result<Rendered, ErrorBody> {
  const located = locate(context, payoutId);
  if (!located.ok) return located;
  const record = located.value;

  const transaction = record.transactions.find((candidate) => candidate.id === transactionId);
  if (transaction === undefined) return err(notFound('Transaction not found'));
  if (transaction.status !== 'pending') return err(notCancellable(transaction.status));

  const cancelled: TransactionRecord = {
    ...transaction,
    status: 'cancelled',
    detail: 'cancelled_by_collector',
  };
  record.transactions = record.transactions.map((candidate) =>
    candidate.id === transactionId ? cancelled : candidate,
  );
  record.updatedAt = context.clock.now();

  const document = toDocument(record);
  context.store.documents.update(document);
  emit(context, record.id, 'payout.updated');
  return ok({ status: 200, body: renderTransaction(cancelled) });
}

// ---------------------------------------------------------------------------
// transaction intents
// ---------------------------------------------------------------------------

/** Intent status is a view over the payment the intent produced. */
const INTENT_STATUS: Record<string, PayoutTransactionStatus> = {
  approved: 'processed',
  rejected: 'failed',
  cancelled: 'cancelled',
  refunded: 'cancelled',
};

const intentState = (payment: JsonObject): PayoutState => ({
  status: INTENT_STATUS[readString(payment, 'status') ?? ''] ?? 'pending',
  detail: readString(payment, 'status_detail') ?? 'pending',
});

/**
 * `point_of_interaction.type` names the rail (`PIX`); `payment_method_id` wins when given.
 * The code is handed to the payments catalogue, so a rail payground does not emulate is
 * refused there rather than silently mapped to another one.
 */
function methodFor(body: JsonObject): string {
  const explicit = readString(body, 'payment_method_id');
  if (explicit !== null) return explicit;
  const point = readString(readObject(body, 'point_of_interaction'), 'type');
  return point === null ? 'pix' : point.toLowerCase();
}

const receiverEmail = (receiver: JsonObject): string => {
  const key = readString(receiver, 'pix_key') ?? '';
  return PIX_KEYS[0]?.test(key) === true ? key : 'payout@payground.local';
};

export function processTransactionIntent(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));

  const transaction = readObject(body, 'transaction');
  const amount = parseAmount(transaction['amount']);
  if (amount === null) return err(invalid(3003, 'transaction.amount invalid'));

  const currencyId = readString(transaction, 'currency_id') ?? 'BRL';
  if (currencyId !== 'BRL') return err(invalid(3005, 'transaction.currency_id must be BRL'));

  // The receiver is optional here, as the documented Pix sample shows, but a receiver that
  // is present is held to the same rules as one in a payout batch.
  const raw = transaction['receiver'];
  const parsed = raw === undefined ? ok({}) : parseReceiver(raw, 'transaction.receiver');
  if (!parsed.ok) return parsed;
  const receiver = parsed.value;

  const externalReference = readString(body, 'external_reference');
  const notificationUrl = readString(body, 'notification_url');
  const method = methodFor(body);

  const created = createPayment(context, {
    transaction_amount: toDecimal(amount),
    payment_method_id: method,
    payer: { email: receiverEmail(receiver) },
    ...(externalReference === null ? {} : { external_reference: externalReference }),
    ...(notificationUrl === null ? {} : { notification_url: notificationUrl }),
  });
  if (!created.ok) return created;
  if (!isJsonObject(created.value.body)) return err(badRequest('the payment could not be created'));
  const payment = created.value.body;

  const now = context.clock.now();
  const state = intentState(payment);
  const id = context.ids.uuid();
  const doc: JsonObject = {
    id,
    ...(externalReference === null ? {} : { external_reference: externalReference }),
    status: state.status,
    status_detail: state.detail,
    payment_id: String(payment['id'] ?? ''),
    point_of_interaction: { type: method.toUpperCase() },
    transaction: {
      amount: toDecimal(amount),
      currency_id: currencyId,
      receiver,
    },
    date_created: formatDateTime(now),
    date_last_updated: formatDateTime(now),
  };

  context.store.documents.insert({
    kind: 'transaction_intent',
    id,
    sequence: context.store.nextSequence('transaction_intent'),
    status: state.status,
    externalReference,
    lookup: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    doc,
  });
  emit(context, id, 'transaction_intent.created');

  return ok({ status: 201, body: { ...doc, payment } });
}

export function getTransactionIntent(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const document = context.store.documents.get('transaction_intent', id);
  if (document === null) return err(notFound('Transaction intent not found'));

  const found = getPayment(context, readString(document.doc, 'payment_id') ?? '');
  if (!found.ok || !isJsonObject(found.value.body)) return ok({ status: 200, body: document.doc });
  const payment = found.value.body;

  const state = intentState(payment);
  if (state.status === document.status && state.detail === readString(document.doc, 'status_detail')) {
    return ok({ status: 200, body: { ...document.doc, payment } });
  }

  const now = context.clock.now();
  const doc: JsonObject = {
    ...document.doc,
    status: state.status,
    status_detail: state.detail,
    date_last_updated: formatDateTime(now),
  };
  context.store.documents.update({ ...document, status: state.status, updatedAt: now, doc });
  emit(context, id, 'transaction_intent.updated');

  return ok({ status: 200, body: { ...doc, payment } });
}
