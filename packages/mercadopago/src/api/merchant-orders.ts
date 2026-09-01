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
  minor,
  ok,
  toDecimal,
} from '@payground/core';
import { type ErrorBody, badRequest, conflict, notFound } from '../errors.ts';
import { providerStatus } from '../mapping/status.ts';
import { formatDateTime } from '../serialize/datetime.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { readNumber, readObjects, readString } from './document.ts';
import { type PreferenceView, SITE_ID, preferenceView } from './preferences.ts';

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
    // A partial refund leaves the payment `approved`, so the reversal is read from the entry;
    // a chargeback reverses the whole payment without ever recording an `amount_refunded`.
    refunded += Math.max(
      toMinor(readNumber(payment, 'amount_refunded') ?? 0),
      REFUNDED.includes(status) ? amount : 0,
    );
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

/**
 * A preference-owned order takes its amount due and its expiry window from the preference;
 * a directly created one owns its own items, so the due amount is the order's own total.
 */
function dueOf(context: ServiceContext, doc: JsonObject, now: number): { due: number; expired: boolean } {
  const preferenceId = readString(doc, 'preference_id');
  const preference =
    preferenceId === null ? null : context.store.documents.get('preference', preferenceId);
  if (preference !== null) {
    const view = preferenceView(preference, now);
    return { due: view.dueMinor, expired: view.expired };
  }
  const total = toMinor(readNumber(doc, 'total_amount') ?? 0);
  const shipping = toMinor(readNumber(doc, 'shipping_cost') ?? 0);
  return { due: total + shipping, expired: false };
}

/** Expiry is derived from the preference on read, so a GET never reports a stale status. */
function materialize(context: ServiceContext, document: StoredDocument): StoredDocument {
  const now = context.clock.now();
  const { due, expired } = dueOf(context, document.doc, now);
  const updated = recompute(document, due, expired, now);
  const unchanged = (['order_status', 'paid_amount', 'refunded_amount'] as const).every(
    (key) => updated.doc[key] === document.doc[key],
  );
  if (unchanged) return document;

  context.store.documents.update(updated);
  return updated;
}

interface OrderSeed {
  preferenceId: string | null;
  externalReference: string | null;
  marketplace: string;
  notificationUrl: string | null;
  payer: JsonValue;
  items: JsonObject[];
  shipments: JsonObject[];
  totalMinor: Minor;
  shippingMinor: Minor;
  expiresAt: number | null;
}

function insert(
  context: ServiceContext,
  seed: OrderSeed,
  patch: JsonObject,
  now: number,
): StoredDocument {
  const sequence = SEQUENCE_BASE + context.store.nextSequence('merchant_order');
  const doc: JsonObject = {
    id: sequence,
    status: 'opened',
    order_status: 'payment_required',
    external_reference: seed.externalReference,
    preference_id: seed.preferenceId,
    application_id: null,
    site_id: SITE_ID,
    is_test: !context.sandbox.liveMode,
    marketplace: seed.marketplace,
    notification_url: seed.notificationUrl,
    sponsor_id: null,
    collector: { id: context.collectorId, email: '', nickname: 'PAYGROUND' },
    payer: seed.payer,
    items: seed.items,
    payments: [],
    shipments: seed.shipments,
    total_amount: toDecimal(seed.totalMinor),
    shipping_cost: toDecimal(seed.shippingMinor),
    paid_amount: 0,
    refunded_amount: 0,
    cancelled: false,
    additional_info: '',
    date_created: formatDateTime(now),
    last_updated: formatDateTime(now),
    ...patch,
  };

  const document: StoredDocument = {
    kind: 'merchant_order',
    id: String(sequence),
    sequence,
    status: 'opened',
    externalReference: readString(doc, 'external_reference'),
    lookup: seed.preferenceId,
    createdAt: now,
    updatedAt: now,
    expiresAt: seed.expiresAt,
    doc,
  };

  context.store.documents.insert(document);
  return document;
}

function create(context: ServiceContext, preferenceId: string, now: number): StoredDocument | null {
  const preference = context.store.documents.get('preference', preferenceId);
  if (preference === null) return null;
  const view = preferenceView(preference, now);
  return insert(context, seedFromPreference(preference, view, preferenceId), {}, now);
}

const seedFromPreference = (
  preference: StoredDocument,
  view: PreferenceView,
  preferenceId: string,
): OrderSeed => ({
  preferenceId,
  externalReference: preference.externalReference,
  marketplace: readString(preference.doc, 'marketplace') ?? 'NONE',
  notificationUrl: view.notificationUrl,
  payer: preference.doc['payer'] ?? null,
  items: view.items,
  shipments: [],
  totalMinor: view.totalMinor,
  shippingMinor: view.shippingMinor,
  expiresAt: preference.expiresAt,
});

interface PaymentEntry {
  id: number;
  status: string;
  statusDetail: string;
  amount: number;
  paid: number;
  refunded: number;
  shippingCost: number;
  currency: string;
  createdAt: number;
  approvedAt: number | null;
}

function paymentEntry(entry: PaymentEntry): JsonObject {
  return {
    id: entry.id,
    transaction_amount: entry.amount,
    total_paid_amount: entry.paid,
    shipping_cost: entry.shippingCost,
    currency_id: entry.currency,
    status: entry.status,
    status_detail: entry.statusDetail,
    operation_type: 'regular_payment',
    date_created: formatDateTime(entry.createdAt),
    date_approved: entry.approvedAt === null ? null : formatDateTime(entry.approvedAt),
    amount_refunded: entry.refunded,
  };
}

function upsertPayment(payments: readonly JsonObject[], entry: JsonObject): JsonObject[] {
  const index = payments.findIndex((payment) => readNumber(payment, 'id') === readNumber(entry, 'id'));
  return index === -1 ? [...payments, entry] : payments.with(index, entry);
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
  const entry = paymentEntry({
    id: paymentSequence,
    status,
    statusDetail: '',
    amount,
    paid: amount,
    refunded: REFUNDED.includes(status) ? amount : 0,
    shippingCost: toDecimal(view.shippingMinor),
    currency: view.currency,
    createdAt: now,
    approvedAt: collected ? now : null,
  });
  const next = upsertPayment(readObjects(document.doc, 'payments'), entry);

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

const DEFAULT_CURRENCY = 'BRL';

/** https://www.mercadopago.com.br/developers/en/reference/merchant_orders/_merchant_orders/post */
const SITE_IDS: readonly string[] = ['MLA', 'MLB', 'MLM', 'MLC', 'MCO', 'MPE', 'MLU'];

const invalid = (description: string, code: string | number = 2034): ErrorBody =>
  badRequest('invalid parameters', [{ code, description }]);

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Fields a merchant order owns outright, on both creation and update. */
function parseSettings(body: JsonObject): Result<JsonObject, ErrorBody> {
  const patch: JsonObject = {};

  const externalReference = body['external_reference'];
  if (externalReference !== undefined) {
    if (externalReference !== null && typeof externalReference !== 'string') {
      return err(invalid('external_reference must be a string', 2008));
    }
    patch['external_reference'] = externalReference;
  }

  // `marketplace` and `additional_info` are never null on the resource; null resets the default.
  const marketplace = body['marketplace'];
  if (marketplace !== undefined) {
    if (marketplace !== null && typeof marketplace !== 'string') {
      return err(invalid('marketplace must be a string'));
    }
    patch['marketplace'] = marketplace ?? 'NONE';
  }

  const additionalInfo = body['additional_info'];
  if (additionalInfo !== undefined) {
    if (additionalInfo !== null && typeof additionalInfo !== 'string') {
      return err(invalid('additional_info must be a string'));
    }
    patch['additional_info'] = additionalInfo ?? '';
  }

  // The spec types application_id as a string; the real API reports the numeric application id.
  const applicationId = body['application_id'];
  if (applicationId !== undefined) {
    if (
      applicationId !== null &&
      typeof applicationId !== 'string' &&
      typeof applicationId !== 'number'
    ) {
      return err(invalid('application_id must be a string or a number'));
    }
    patch['application_id'] = applicationId;
  }

  const siteId = body['site_id'];
  if (siteId !== undefined) {
    if (typeof siteId !== 'string' || !SITE_IDS.includes(siteId)) {
      return err(invalid('site_id is unknown', 2035));
    }
    patch['site_id'] = siteId;
  }

  const notificationUrl = body['notification_url'];
  if (notificationUrl !== undefined) {
    if (
      notificationUrl !== null &&
      (typeof notificationUrl !== 'string' || !isHttpUrl(notificationUrl))
    ) {
      return err(invalid('notification_url must be an absolute http(s) URL', 2007));
    }
    patch['notification_url'] = notificationUrl;
  }

  const sponsorId = body['sponsor_id'];
  if (sponsorId !== undefined) {
    if (sponsorId !== null && (typeof sponsorId !== 'number' || !Number.isSafeInteger(sponsorId))) {
      return err(invalid('sponsor_id must be an integer'));
    }
    patch['sponsor_id'] = sponsorId;
  }

  const payer = body['payer'];
  if (payer !== undefined) {
    if (payer !== null && !isJsonObject(payer)) return err(invalid('payer must be a Json object'));
    patch['payer'] = payer;
  }

  return ok(patch);
}

/** As strict as the preference cart: an order with nothing due could never reach `paid`. */
function parseItems(raw: unknown): Result<{ items: JsonObject[]; totalMinor: Minor }, ErrorBody> {
  if (!Array.isArray(raw)) return err(invalid('items must be an array'));
  if (raw.length === 0) return err(invalid('items must contain at least one item', 2001));

  const items: JsonObject[] = [];
  let total = 0;

  for (const [index, entry] of raw.entries()) {
    if (!isJsonObject(entry)) return err(invalid(`items[${index}] must be a Json object`));

    const quantity = entry['quantity'] ?? 1;
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1) {
      return err(invalid(`items[${index}].quantity must be a positive integer`, 2003));
    }
    const price = fromDecimal(typeof entry['unit_price'] === 'number' ? entry['unit_price'] : Number.NaN);
    if (!price.ok) return err(invalid(`items[${index}].unit_price invalid`, 2004));
    if (price.value === 0) return err(invalid(`items[${index}].unit_price must be greater than 0`, 2004));

    total += price.value * quantity;
    items.push({
      ...entry,
      quantity,
      currency_id: readString(entry, 'currency_id') ?? DEFAULT_CURRENCY,
      unit_price: toDecimal(price.value),
    });
  }

  const totalMinor = minor(total);
  if (!totalMinor.ok) return err(invalid('items total is too large', 2005));
  return ok({ items, totalMinor: totalMinor.value });
}

function parseShipments(raw: unknown): Result<{ shipments: JsonObject[]; costMinor: Minor }, ErrorBody> {
  if (!Array.isArray(raw)) return err(invalid('shipments must be an array'));

  const shipments: JsonObject[] = [];
  let cost = 0;

  for (const [index, entry] of raw.entries()) {
    if (!isJsonObject(entry)) return err(invalid(`shipments[${index}] must be a Json object`));
    // Mercado Pago shipments quote the price under `shipping_option`; `cost` is the flat form.
    const option = isJsonObject(entry['shipping_option']) ? entry['shipping_option'] : {};
    const rawCost = entry['cost'] ?? option['cost'] ?? 0;
    const parsed = fromDecimal(typeof rawCost === 'number' ? rawCost : Number.NaN);
    if (!parsed.ok) return err(invalid(`shipments[${index}].cost invalid`, 2012));
    cost += parsed.value;
    shipments.push({ ...entry, cost: toDecimal(parsed.value) });
  }

  const costMinor = minor(cost);
  if (!costMinor.ok) return err(invalid('shipments total cost is too large', 2005));
  return ok({ shipments, costMinor: costMinor.value });
}

/** `payments` carries references, never amounts: the payment resource stays the source of truth. */
function resolvePayments(
  context: ServiceContext,
  raw: unknown,
  shippingCost: number,
): Result<JsonObject[], ErrorBody> {
  if (!Array.isArray(raw)) return err(invalid('payments must be an array'));

  const entries: JsonObject[] = [];
  for (const [index, entry] of raw.entries()) {
    const reference = isJsonObject(entry) ? entry['id'] : entry;
    const sequence =
      typeof reference === 'number'
        ? reference
        : typeof reference === 'string'
          ? Number(reference)
          : Number.NaN;
    if (!Number.isInteger(sequence)) return err(invalid(`payments[${index}].id must be a payment id`));

    const payment = context.store.payments.bySequence(sequence);
    if (payment === null) return err(invalid(`payments[${index}].id is unknown`));

    const { status, status_detail } = providerStatus(payment);
    entries.push(
      paymentEntry({
        id: sequence,
        status,
        statusDetail: status_detail,
        amount: toDecimal(payment.amount),
        // What the order collected is what the payment captured, as the payment resource reports it.
        paid: toDecimal(payment.capturedAmount),
        refunded: toDecimal(payment.refundedAmount),
        shippingCost,
        currency: payment.currency,
        createdAt: payment.createdAt,
        approvedAt: payment.settledAt,
      }),
    );
  }

  return ok(entries);
}

export function createMerchantOrder(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  if (!isJsonObject(body)) return err(invalid('body must be a Json object'));

  const settings = parseSettings(body);
  if (!settings.ok) return settings;

  const rawPreferenceId = body['preference_id'] ?? null;
  if (rawPreferenceId !== null && typeof rawPreferenceId !== 'string') {
    return err(invalid('preference_id must be a string'));
  }

  const now = context.clock.now();
  let seed: OrderSeed;

  if (rawPreferenceId !== null) {
    const preference = context.store.documents.get('preference', rawPreferenceId);
    if (preference === null) return err(invalid('preference_id is unknown'));
    if (context.store.documents.byLookup('merchant_order', rawPreferenceId) !== null) {
      return err(conflict('a merchant order already exists for this preference'));
    }
    // The preference owns the cart, so payground never lets an order hold a rival copy of it.
    if (body['items'] !== undefined || body['shipments'] !== undefined) {
      return err(invalid('items and shipments of a preference-owned order come from the preference'));
    }
    seed = seedFromPreference(preference, preferenceView(preference, now), rawPreferenceId);
  } else {
    const items = parseItems(body['items']);
    if (!items.ok) return items;
    const shipments = parseShipments(body['shipments'] ?? []);
    if (!shipments.ok) return shipments;

    // Everything the settings patch owns keeps its default here and is overwritten by it.
    seed = {
      preferenceId: null,
      externalReference: null,
      marketplace: 'NONE',
      notificationUrl: null,
      payer: null,
      items: items.value.items,
      shipments: shipments.value.shipments,
      totalMinor: items.value.totalMinor,
      shippingMinor: shipments.value.costMinor,
      expiresAt: null,
    };
  }

  const payments: Result<JsonObject[], ErrorBody> =
    body['payments'] === undefined
      ? ok([])
      : resolvePayments(context, body['payments'], toDecimal(seed.shippingMinor));
  if (!payments.ok) return payments;

  const document = insert(
    context,
    seed,
    { ...settings.value, payments: payments.value.reduce(upsertPayment, []) },
    now,
  );
  // The order may already be expired or paid the moment it is created, so it is never
  // returned before the derived fields have been recomputed.
  return ok({ status: 201, body: materialize(context, document).doc });
}

export function updateMerchantOrder(
  context: ServiceContext,
  id: string,
  body: unknown,
): Result<Rendered, ErrorBody> {
  const sequence = Number(id);
  if (!Number.isInteger(sequence)) return err(notFound('Merchant order not found'));
  const found = context.store.documents.bySequence('merchant_order', sequence);
  if (found === null) return err(notFound('Merchant order not found'));
  if (!isJsonObject(body)) return err(invalid('body must be a Json object'));

  const settings = parseSettings(body);
  if (!settings.ok) return settings;

  const document = materialize(context, found);
  const preferenceId = readString(document.doc, 'preference_id');
  if (body['preference_id'] !== undefined && body['preference_id'] !== preferenceId) {
    return err(invalid('preference_id cannot be changed'));
  }

  let doc: JsonObject = { ...document.doc, ...settings.value };

  const hasItems = body['items'] !== undefined;
  const hasShipments = body['shipments'] !== undefined;
  // A preference-owned order mirrors its preference: the cart is edited there, never here.
  if ((hasItems || hasShipments) && preferenceId !== null) {
    return err(invalid('items and shipments follow the preference; update the preference instead'));
  }
  if (hasItems) {
    const items = parseItems(body['items']);
    if (!items.ok) return items;
    doc = { ...doc, items: items.value.items, total_amount: toDecimal(items.value.totalMinor) };
  }
  if (hasShipments) {
    const shipments = parseShipments(body['shipments']);
    if (!shipments.ok) return shipments;
    doc = {
      ...doc,
      shipments: shipments.value.shipments,
      shipping_cost: toDecimal(shipments.value.costMinor),
    };
  }

  const now = context.clock.now();
  if (body['payments'] !== undefined) {
    const shippingCost = toDecimal(toMinor(readNumber(doc, 'shipping_cost') ?? 0));
    const resolved = resolvePayments(context, body['payments'], shippingCost);
    if (!resolved.ok) return resolved;
    doc = { ...doc, payments: resolved.value.reduce(upsertPayment, readObjects(doc, 'payments')) };
  }

  const { due, expired } = dueOf(context, doc, now);
  const recomputed = recompute({ ...document, doc }, due, expired, now);
  const stored: StoredDocument = {
    ...recomputed,
    externalReference: readString(recomputed.doc, 'external_reference'),
  };
  context.store.documents.update(stored);
  return ok({ status: 200, body: stored.doc });
}
