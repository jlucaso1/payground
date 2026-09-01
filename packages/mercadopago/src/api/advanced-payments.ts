import {
  type JsonObject,
  type Minor,
  type PaymentCommand,
  type PaymentCommandType,
  type Result,
  type StoredDocument,
  ZERO,
  add,
  apply,
  err,
  fromDecimal,
  isAllowed,
  isJsonObject,
  ok,
  toDecimal,
} from '@payground/core';
import { type ErrorBody, badRequest, notFound, unprocessable } from '../errors.ts';
import { formatDateTime } from '../serialize/datetime.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { readNumber, readObjects, readString } from './document.ts';
import { SITE_ID } from './preferences.ts';
import { createPayment, createRefund, getPayment, materialize, updatePayment } from './payments.ts';
import { commit } from './transition.ts';

/** Advanced payment and disbursement ids live in their own bands. */
const SEQUENCE_BASE = 3_000_000_000;
const DISBURSEMENT_BASE = 4_000_000_000;

const DAY_MS = 24 * 60 * 60 * 1000;

interface Split {
  amount: Minor;
  collectorId: number;
  applicationFee: Minor;
  moneyReleaseDays: number;
  externalReference: string | null;
}

interface Request {
  entries: JsonObject[];
  disbursements: Split[];
  payer: JsonObject;
  payerEmail: string;
  description: string | null;
  externalReference: string | null;
  binaryMode: boolean;
  capture: boolean;
}

const invalid = (description: string): ErrorBody =>
  badRequest('invalid parameters', [{ code: 2034, description }]);

function minorOf(value: unknown, minimum: number): Minor | null {
  if (typeof value !== 'number') return null;
  const parsed = fromDecimal(value);
  return parsed.ok && parsed.value >= minimum ? parsed.value : null;
}

const amountOf = (value: unknown): Minor | null => minorOf(value, 1);

function sum(values: readonly Minor[]): Minor | null {
  let total: Minor = ZERO;
  for (const value of values) {
    const next = add(total, value);
    if (!next.ok) return null;
    total = next.value;
  }
  return total;
}

/** `wallet_payment` is the Wallet Connect spelling of a single account money payment. */
function entriesOf(body: JsonObject): JsonObject[] | null {
  const payments = body['payments'];
  if (Array.isArray(payments)) {
    return payments.every(isJsonObject) ? (payments as JsonObject[]) : null;
  }
  const wallet = body['wallet_payment'];
  if (!isJsonObject(wallet)) return null;
  return [{ ...wallet, payment_method_id: 'account_money' }];
}

function splitOf(context: ServiceContext, value: unknown): Split | null {
  if (!isJsonObject(value)) return null;
  const amount = amountOf(value['amount']);
  if (amount === null) return null;

  const fee = value['application_fee'] === undefined ? ZERO : minorOf(value['application_fee'], 0);
  if (fee === null || fee > amount) return null;

  const days = value['money_release_days'];
  if (days !== undefined && (!Number.isInteger(days) || (days as number) < 0)) return null;

  const collector = value['collector_id'];
  if (collector !== undefined && !Number.isInteger(collector)) return null;

  return {
    amount,
    applicationFee: fee,
    collectorId: collector === undefined ? context.collectorId : (collector as number),
    moneyReleaseDays: days === undefined ? 0 : (days as number),
    externalReference: readString(value, 'external_reference'),
  };
}

function parse(context: ServiceContext, body: unknown): Result<Request, ErrorBody> {
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));

  const entries = entriesOf(body);
  if (entries === null || entries.length === 0) return err(invalid('payments is required'));

  const amounts: Minor[] = [];
  for (const entry of entries) {
    const amount = amountOf(entry['transaction_amount']);
    if (amount === null) return err(invalid('payments[].transaction_amount invalid'));
    amounts.push(amount);
  }

  const raw = body['disbursements'];
  if (!Array.isArray(raw) || raw.length === 0) return err(invalid('disbursements is required'));
  const disbursements: Split[] = [];
  for (const value of raw) {
    const split = splitOf(context, value);
    if (split === null) return err(invalid('disbursements[] invalid'));
    disbursements.push(split);
  }

  // The split must add up to the collected amount, exactly as the real API demands.
  const split = sum(disbursements.map((entry) => entry.amount));
  const collected = sum(amounts);
  if (split === null || collected === null) return err(invalid('amount out of range'));
  if (split !== collected) return err(invalid('disbursements must add up to the payments total'));

  const payer = isJsonObject(body['payer']) ? body['payer'] : {};
  const email = readString(payer, 'email');
  const token = readString(payer, 'token');
  // Wallet Connect identifies the payer by token alone; payground still needs an address.
  const payerEmail = email ?? (token === null ? null : `wallet+${token}@payground.local`);
  if (payerEmail === null) return err(invalid('payer.email is required'));

  return ok({
    entries,
    disbursements,
    payer,
    payerEmail,
    description: readString(body, 'description'),
    externalReference: readString(body, 'external_reference'),
    binaryMode: body['binary_mode'] === true,
    capture: body['capture'] !== false,
  });
}

const STATUS_ORDER: readonly string[] = [
  'rejected',
  'pending',
  'in_process',
  'authorized',
  'charged_back',
  'in_mediation',
  'refunded',
  'cancelled',
  'approved',
];

/**
 * The aggregate reports the least advanced outcome among the split payments: one
 * rejection rejects the whole advanced payment.
 */
export function aggregateStatus(statuses: readonly string[]): string {
  if (statuses.length === 0) return 'pending';
  let best = 'approved';
  for (const status of statuses) {
    const rank = STATUS_ORDER.indexOf(status);
    if (rank !== -1 && rank < STATUS_ORDER.indexOf(best)) best = status;
  }
  return best;
}

function childBody(request: Request, entry: JsonObject): JsonObject {
  const payer: JsonObject = { ...request.payer, email: request.payerEmail };
  const description = readString(entry, 'description') ?? request.description;
  const externalReference = readString(entry, 'external_reference') ?? request.externalReference;

  return {
    transaction_amount: entry['transaction_amount'] ?? 0,
    payer,
    binary_mode: request.binaryMode,
    capture: request.capture,
    ...(typeof entry['payment_method_id'] === 'string'
      ? { payment_method_id: entry['payment_method_id'] }
      : {}),
    ...(typeof entry['token'] === 'string' ? { token: entry['token'] } : {}),
    ...(typeof entry['installments'] === 'number' ? { installments: entry['installments'] } : {}),
    ...(description === null ? {} : { description }),
    ...(externalReference === null ? {} : { external_reference: externalReference }),
  };
}

const paymentsOf = (context: ServiceContext, document: StoredDocument): JsonObject[] =>
  readObjects(document.doc, 'payments').map((payment) => {
    const sequence = readNumber(payment, 'id');
    if (sequence === null) return payment;
    const fresh = getPayment(context, String(sequence));
    return fresh.ok && isJsonObject(fresh.value.body) ? fresh.value.body : payment;
  });

/** The split payments carry the state, so the aggregate is recomputed on every read. */
function render(context: ServiceContext, document: StoredDocument): JsonObject {
  const payments = paymentsOf(context, document);
  const status = aggregateStatus(payments.map((payment) => readString(payment, 'status') ?? 'pending'));

  if (status === document.status) return { ...document.doc, payments };

  const now = context.clock.now();
  const doc: JsonObject = { ...document.doc, status, date_last_updated: formatDateTime(now) };
  context.store.documents.update({ ...document, status, updatedAt: now, doc });
  return { ...doc, payments };
}

/** Whatever a rejected split leaves collected is given back, so nothing is half-paid. */
function unwind(context: ServiceContext, sequences: readonly number[]): void {
  const now = context.clock.now();
  for (const sequence of sequences) {
    const found = context.store.payments.bySequence(sequence);
    if (found === null) continue;
    const payment = materialize(context, found);

    // A settled split is refunded so the refund resource exists; a captured one is cancelled.
    if (payment.status.state === 'succeeded') {
      createRefund(context, String(sequence), {});
      continue;
    }
    const command: PaymentCommand =
      payment.status.state === 'in_review'
        ? { type: 'decline', reason: 'other' }
        : { type: 'cancel', by: 'collector' };

    const result = apply(payment, command, now);
    if (result.ok) commit(context, result.value);
  }
}

export function createAdvancedPayment(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  const parsed = parse(context, body);
  if (!parsed.ok) return parsed;
  const request = parsed.value;

  const now = context.clock.now();
  const created: JsonObject[] = [];
  const sequences: number[] = [];

  for (const entry of request.entries) {
    const child = createPayment(context, childBody(request, entry));
    if (!child.ok) {
      unwind(context, sequences);
      return child;
    }
    const rendered = isJsonObject(child.value.body) ? child.value.body : {};
    const sequence = readNumber(rendered, 'id');
    if (sequence !== null) sequences.push(sequence);
    created.push(rendered);
  }

  const sequence = SEQUENCE_BASE + context.store.nextSequence('advanced_payment');
  const disbursements = request.disbursements.map((split) => ({
    id: DISBURSEMENT_BASE + context.store.nextSequence('disbursement'),
    collector_id: split.collectorId,
    amount: toDecimal(split.amount),
    application_fee: toDecimal(split.applicationFee),
    money_release_days: split.moneyReleaseDays,
    money_release_date: formatDateTime(now + split.moneyReleaseDays * DAY_MS),
    external_reference: split.externalReference,
    status: 'pending',
  }));

  const status = aggregateStatus(created.map((payment) => readString(payment, 'status') ?? 'pending'));
  // A rejected split rejects the whole advanced payment, so the rest is given back.
  if (status === 'rejected') unwind(context, sequences);

  const document: StoredDocument = {
    kind: 'advanced_payment',
    id: String(sequence),
    sequence,
    status,
    externalReference: request.externalReference,
    lookup: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    doc: {
      id: sequence,
      status,
      site_id: SITE_ID,
      live_mode: context.sandbox.liveMode,
      application_id: null,
      external_reference: request.externalReference,
      description: request.description,
      binary_mode: request.binaryMode,
      capture: request.capture,
      application_fee: toDecimal(sum(request.disbursements.map((split) => split.applicationFee)) ?? ZERO),
      money_release_days: Math.max(...request.disbursements.map((split) => split.moneyReleaseDays)),
      payer: request.payer,
      payments: created,
      disbursements,
      date_created: formatDateTime(now),
      date_last_updated: formatDateTime(now),
    },
  };
  context.store.documents.insert(document);

  return ok({ status: 201, body: render(context, document) });
}

function locate(context: ServiceContext, id: string): Result<StoredDocument, ErrorBody> {
  const sequence = Number(id);
  if (!Number.isInteger(sequence)) return err(notFound('Advanced payment not found'));
  const found = context.store.documents.bySequence('advanced_payment', sequence);
  if (found === null) return err(notFound('Advanced payment not found'));
  return ok(found);
}

export function getAdvancedPayment(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const located = locate(context, id);
  if (!located.ok) return located;
  return ok({ status: 200, body: render(context, located.value) });
}

const sequencesOf = (document: StoredDocument): number[] =>
  readObjects(document.doc, 'payments')
    .map((payment) => readNumber(payment, 'id'))
    .filter((sequence): sequence is number => sequence !== null);

/** Capture and cancel are all-or-nothing: every split payment must accept the command. */
function allowed(context: ServiceContext, sequences: readonly number[], command: PaymentCommandType): boolean {
  return sequences.every((sequence) => {
    const found = context.store.payments.bySequence(sequence);
    // Reading through materialize applies a pending expiry first, exactly as the update does.
    return found !== null && isAllowed(materialize(context, found).status.state, command);
  });
}

export function updateAdvancedPayment(
  context: ServiceContext,
  id: string,
  body: unknown,
): Result<Rendered, ErrorBody> {
  const located = locate(context, id);
  if (!located.ok) return located;
  const document = located.value;

  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));
  const command: PaymentCommandType | null =
    body['status'] === 'cancelled' ? 'cancel' : body['capture'] === true ? 'capture' : null;
  if (command === null) {
    return err(badRequest('invalid parameters', [{ code: 2001, description: 'nothing to update' }]));
  }

  const sequences = sequencesOf(document);
  if (!allowed(context, sequences, command)) {
    return err(
      unprocessable('operation not allowed', [
        { code: 4051, description: `advanced payment cannot be ${command}ed` },
      ]),
    );
  }

  const patch = command === 'cancel' ? { status: 'cancelled' } : { capture: true };
  for (const sequence of sequences) {
    const updated = updatePayment(context, String(sequence), patch);
    if (!updated.ok) return updated;
  }

  return ok({ status: 200, body: render(context, document) });
}
