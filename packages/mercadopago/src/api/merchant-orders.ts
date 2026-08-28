import {
  type JsonObject,
  type Minor,
  type Result,
  type StoredDocument,
  ZERO,
  err,
  fromDecimal,
  ok,
  toDecimal,
} from '@payground/core';
import { type ErrorBody, badRequest, notFound } from '../errors.ts';
import { formatDateTime } from '../serialize/datetime.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { readNumber, readObjects, readString } from './document.ts';
import { SITE_ID, preferenceView } from './preferences.ts';

/** Merchant order ids live in their own band so they are never mistaken for payment ids. */
const SEQUENCE_BASE = 2_000_000_000;

export type OrderStatus =
  | 'payment_required'
  | 'paid'
  | 'partially_paid'
  | 'partially_refunded'
  | 'refunded'
  | 'expired';

const APPROVED: readonly string[] = ['approved'];
const REFUNDED: readonly string[] = ['refunded', 'charged_back'];

export interface OrderTotals {
  dueMinor: number;
  paidMinor: number;
  refundedMinor: number;
  expired: boolean;
}

/**
 * `order_status` is derived, never stored by the caller. A refunded payment keeps its
 * contribution to `paid_amount` and also counts as refunded, which is what makes
 * `partially_refunded` distinguishable from `partially_paid`.
 * https://www.mercadopago.com.br/developers/en/reference/merchant_orders/_merchant_orders_id/get
 */
export function orderStatusOf(totals: OrderTotals): OrderStatus {
  if (totals.refundedMinor > 0) {
    return totals.refundedMinor >= totals.paidMinor ? 'refunded' : 'partially_refunded';
  }
  if (totals.dueMinor > 0 && totals.paidMinor >= totals.dueMinor) return 'paid';
  if (totals.expired) return 'expired';
  if (totals.paidMinor > 0) return 'partially_paid';
  return 'payment_required';
}

const toMinor = (value: number): Minor => {
  const parsed = fromDecimal(value);
  return parsed.ok ? parsed.value : ZERO;
};

function totalsOf(payments: readonly JsonObject[], dueMinor: number, expired: boolean): OrderTotals {
  let paid = 0;
  let refunded = 0;
  for (const payment of payments) {
    const status = readString(payment, 'status') ?? '';
    const amount = toMinor(readNumber(payment, 'total_paid_amount') ?? 0);
    if (APPROVED.includes(status) || REFUNDED.includes(status)) paid += amount;
    if (REFUNDED.includes(status)) refunded += amount;
  }
  return { dueMinor, paidMinor: paid, refundedMinor: refunded, expired };
}

function recompute(document: StoredDocument, dueMinor: number, expired: boolean, now: number): StoredDocument {
  const payments = readObjects(document.doc, 'payments');
  const totals = totalsOf(payments, dueMinor, expired);
  const orderStatus = orderStatusOf(totals);
  const status = orderStatus === 'expired' ? 'expired' : orderStatus === 'paid' ? 'closed' : 'opened';

  return {
    ...document,
    status,
    updatedAt: now,
    doc: {
      ...document.doc,
      status,
      order_status: orderStatus,
      paid_amount: toDecimal(totals.paidMinor as Minor),
      refunded_amount: toDecimal(totals.refundedMinor as Minor),
      last_updated: formatDateTime(now),
    },
  };
}

export function orderForPreference(context: ServiceContext, preferenceId: string): StoredDocument | null {
  const found = context.store.documents.byLookup('merchant_order', preferenceId);
  if (found === null) return null;
  return materialize(context, found);
}

/** Expiry is derived from the preference on read, so a GET never reports a stale status. */
function materialize(context: ServiceContext, document: StoredDocument): StoredDocument {
  const preferenceId = readString(document.doc, 'preference_id');
  const preference =
    preferenceId === null ? null : context.store.documents.get('preference', preferenceId);
  if (preference === null) return document;

  const now = context.clock.now();
  const view = preferenceView(preference, now);
  const updated = recompute(document, view.dueMinor, view.expired, now);
  const unchanged = (['order_status', 'paid_amount', 'refunded_amount'] as const).every(
    (key) => updated.doc[key] === document.doc[key],
  );
  if (unchanged) return document;

  context.store.documents.update(updated);
  return updated;
}

function create(context: ServiceContext, preferenceId: string, now: number): StoredDocument | null {
  const preference = context.store.documents.get('preference', preferenceId);
  if (preference === null) return null;
  const view = preferenceView(preference, now);
  const sequence = SEQUENCE_BASE + context.store.nextSequence('merchant_order');

  const document: StoredDocument = {
    kind: 'merchant_order',
    id: String(sequence),
    sequence,
    status: 'opened',
    externalReference: preference.externalReference,
    lookup: preferenceId,
    createdAt: now,
    updatedAt: now,
    expiresAt: preference.expiresAt,
    doc: {
      id: sequence,
      status: 'opened',
      order_status: 'payment_required',
      external_reference: preference.externalReference,
      preference_id: preferenceId,
      application_id: null,
      site_id: SITE_ID,
      is_test: !context.sandbox.liveMode,
      marketplace: readString(preference.doc, 'marketplace') ?? 'NONE',
      notification_url: view.notificationUrl,
      sponsor_id: null,
      collector: { id: context.collectorId, email: '', nickname: 'PAYGROUND' },
      payer: preference.doc['payer'] ?? null,
      items: view.items,
      payments: [],
      shipments: [],
      total_amount: toDecimal(view.totalMinor),
      shipping_cost: toDecimal(view.shippingMinor),
      paid_amount: 0,
      refunded_amount: 0,
      cancelled: false,
      additional_info: '',
      date_created: formatDateTime(now),
      last_updated: formatDateTime(now),
    },
  };

  context.store.documents.insert(document);
  return document;
}

export function attachPayment(
  context: ServiceContext,
  preferenceId: string,
  paymentSequence: number,
  status: string,
  amount: number,
): void {
  const now = context.clock.now();
  const existing = context.store.documents.byLookup('merchant_order', preferenceId);
  const document = existing ?? create(context, preferenceId, now);
  if (document === null) return;

  const preference = context.store.documents.get('preference', preferenceId);
  if (preference === null) return;
  const view = preferenceView(preference, now);

  const collected = status === 'approved' || REFUNDED.includes(status);
  const entry: JsonObject = {
    id: paymentSequence,
    transaction_amount: amount,
    total_paid_amount: amount,
    shipping_cost: toDecimal(view.shippingMinor),
    currency_id: view.currency,
    status,
    status_detail: '',
    operation_type: 'regular_payment',
    date_created: formatDateTime(now),
    date_approved: collected ? formatDateTime(now) : null,
    amount_refunded: REFUNDED.includes(status) ? amount : 0,
  };

  const payments = readObjects(document.doc, 'payments');
  const index = payments.findIndex((payment) => readNumber(payment, 'id') === paymentSequence);
  const next = index === -1 ? [...payments, entry] : payments.with(index, entry);

  context.store.documents.update(
    recompute({ ...document, doc: { ...document.doc, payments: next } }, view.dueMinor, view.expired, now),
  );
}

export function getMerchantOrder(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const sequence = Number(id);
  if (!Number.isInteger(sequence)) return err(notFound('Merchant order not found'));
  const found = context.store.documents.bySequence('merchant_order', sequence);
  if (found === null) return err(notFound('Merchant order not found'));
  return ok({ status: 200, body: materialize(context, found).doc });
}

export function searchMerchantOrders(
  context: ServiceContext,
  params: URLSearchParams,
): Result<Rendered, ErrorBody> {
  const limit = params.has('limit') ? Number(params.get('limit')) : undefined;
  const offset = params.has('offset') ? Number(params.get('offset')) : undefined;
  if (limit !== undefined && !Number.isFinite(limit)) {
    return err(badRequest('invalid parameters', [{ code: 2034, description: 'limit invalid' }]));
  }
  if (offset !== undefined && !Number.isFinite(offset)) {
    return err(badRequest('invalid parameters', [{ code: 2034, description: 'offset invalid' }]));
  }

  const page = context.store.documents.search('merchant_order', {
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
    ...(params.has('status') ? { status: params.get('status') as string } : {}),
    ...(params.has('external_reference')
      ? { externalReference: params.get('external_reference') as string }
      : {}),
    ...(params.has('preference_id') ? { lookup: params.get('preference_id') as string } : {}),
    order: params.get('criteria') === 'asc' ? 'asc' : 'desc',
  });

  return ok({
    status: 200,
    body: {
      elements: page.results.map((document) => materialize(context, document).doc),
      next_offset: page.offset + page.results.length,
      total: page.total,
    },
  });
}
