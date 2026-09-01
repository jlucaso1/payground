import {
  type JsonObject,
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
import { type ErrorBody, badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { formatDateTime } from '../serialize/datetime.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { readNumber, readObject, readString } from './document.ts';
import { attachPayment, orderForPreference } from './merchant-orders.ts';
import { createPayment, getPayment, updatePayment } from './payments.ts';
import { createPreference } from './preferences.ts';

/**
 * Seven of these operations are deprecated in the spec (the V1, V2 and dynamic-QR
 * families). They keep working here because integrations built before the Orders API
 * still call them against staging.
 * https://www.mercadopago.com/developers/en/docs/qr-code/orders/create-order
 */

const CONFIG_ID = 'integrator';
const DEFAULT_UNIT = 'unit';
const DEFAULT_CURRENCY = 'BRL';
/** An in-store order has no payer until the QR is scanned; the Pix payment needs one. */
const QR_PAYER_EMAIL = 'qr@payground.local';

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

export interface PosRef {
  userId: string;
  externalPosId: string;
  externalStoreId: string | null;
}

const posKey = (ref: PosRef): string => `${ref.userId}-${ref.externalPosId}`;

/** The collector in the path is the token's own: another one addresses another account. */
const checkRef = (context: ServiceContext, ref: PosRef): ErrorBody | null => {
  if (!/^\d+$/.test(ref.userId)) return invalid('user_id must be numeric', 2009);
  return Number(ref.userId) === context.collectorId
    ? null
    : forbidden('user_id does not belong to this access token');
};

interface Draft {
  externalReference: string;
  title: string | null;
  description: string | null;
  totalMinor: Minor;
  items: JsonObject[];
  notificationUrl: string | null;
  expirationDate: string | null;
  expiresAt: number | null;
  cashOutMinor: Minor;
}

function parseItems(raw: unknown): Result<{ items: JsonObject[]; totalMinor: Minor }, ErrorBody> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return err(invalid('items must contain at least one item', 2001));
  }

  const items: JsonObject[] = [];
  let total = 0;

  for (const [index, entry] of raw.entries()) {
    if (!isJsonObject(entry)) return err(invalid(`items[${index}] must be a Json object`, 2002));

    const title = readString(entry, 'title');
    if (title === null || title.trim() === '') {
      return err(invalid(`items[${index}].title must not be empty`, 2002));
    }

    const quantity = readNumber(entry, 'quantity');
    if (quantity === null || !Number.isSafeInteger(quantity) || quantity < 1) {
      return err(invalid(`items[${index}].quantity must be a positive integer`, 2003));
    }

    const price = fromDecimal(readNumber(entry, 'unit_price') ?? Number.NaN);
    if (!price.ok || price.value <= 0) return err(invalid(`items[${index}].unit_price invalid`, 2004));

    // The order is collected with Pix, which settles in BRL only.
    const currency = readString(entry, 'currency_id') ?? DEFAULT_CURRENCY;
    if (currency !== DEFAULT_CURRENCY) {
      return err(invalid(`items[${index}].currency_id must be ${DEFAULT_CURRENCY}`, 2014));
    }

    const line = price.value * quantity;
    const declared = entry['total_amount'];
    if (declared !== undefined && declared !== null) {
      const parsed = fromDecimal(typeof declared === 'number' ? declared : Number.NaN);
      if (!parsed.ok || parsed.value !== line) {
        return err(invalid(`items[${index}].total_amount must equal unit_price * quantity`, 2005));
      }
    }
    total += line;

    items.push({
      sku_number: entry['sku_number'] ?? null,
      category: entry['category'] ?? null,
      title,
      description: entry['description'] ?? null,
      unit_price: toDecimal(price.value),
      quantity,
      unit_measure: readString(entry, 'unit_measure') ?? DEFAULT_UNIT,
      total_amount: toDecimal(line as Minor),
      currency_id: currency,
    });
  }

  const totalMinor = minor(total);
  if (!totalMinor.ok) return err(invalid('items total is too large', 2005));
  return ok({ items, totalMinor: totalMinor.value });
}

function parse(body: unknown): Result<Draft, ErrorBody> {
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));

  const externalReference = readString(body, 'external_reference');
  if (externalReference === null || externalReference.trim() === '') {
    return err(invalid('external_reference is required', 2006));
  }

  const parsedItems = parseItems(body['items']);
  if (!parsedItems.ok) return parsedItems;

  const declaredTotal = fromDecimal(readNumber(body, 'total_amount') ?? Number.NaN);
  if (!declaredTotal.ok || declaredTotal.value <= 0) return err(invalid('total_amount invalid', 2007));
  if (declaredTotal.value !== parsedItems.value.totalMinor) {
    return err(invalid('total_amount must equal the sum of the items', 2007));
  }

  const notificationUrl = readString(body, 'notification_url');
  if (notificationUrl !== null && !isHttpUrl(notificationUrl)) {
    return err(invalid('notification_url must be an absolute http(s) URL', 2008));
  }

  const expirationDate = readString(body, 'expiration_date');
  const expiresAt = expirationDate === null ? null : Date.parse(expirationDate);
  if (expiresAt !== null && Number.isNaN(expiresAt)) return err(invalid('expiration_date invalid', 2010));

  // Cash out is carried alongside the items, never inside total_amount, so the merchant
  // order stays equal to what the buyer is charged for goods.
  const rawCashOut = body['cash_out'];
  let cashOutMinor: Minor = ZERO;
  if (rawCashOut !== undefined && rawCashOut !== null) {
    if (!isJsonObject(rawCashOut)) return err(invalid('cash_out must be a Json object', 2011));
    const amount = rawCashOut['amount'];
    if (amount !== undefined && amount !== null) {
      const parsed = typeof amount === 'number' ? fromDecimal(amount) : null;
      if (parsed === null || !parsed.ok) return err(invalid('cash_out.amount invalid', 2011));
      cashOutMinor = parsed.value;
    }
  }

  return ok({
    externalReference,
    title: readString(body, 'title'),
    description: readString(body, 'description'),
    totalMinor: declaredTotal.value,
    items: parsedItems.value.items,
    notificationUrl,
    expirationDate,
    expiresAt,
    cashOutMinor,
  });
}

/** `notification_url` is the deprecated spelling of `callback_url` on the integrator config. */
const callbackUrl = (context: ServiceContext): string | null => {
  const config = context.store.documents.get('qr_config', CONFIG_ID);
  if (config === null) return null;
  return readString(config.doc, 'callback_url') ?? readString(config.doc, 'notification_url');
};

function preferenceFor(context: ServiceContext, draft: Draft, notify: string | null): Result<string, ErrorBody> {
  const created = createPreference(context, {
    items: draft.items.map((item) => ({
      title: item['title'],
      quantity: item['quantity'],
      unit_price: item['unit_price'],
      currency_id: item['currency_id'],
    })),
    external_reference: draft.externalReference,
    payer: { email: QR_PAYER_EMAIL },
    ...(notify === null ? {} : { notification_url: notify }),
  });
  if (!created.ok) return created;
  if (!isJsonObject(created.value.body)) return err(badRequest('preference creation failed'));
  const id = readString(created.value.body, 'id');
  return id === null ? err(badRequest('preference creation failed')) : ok(id);
}

interface Charge {
  paymentId: number;
  status: string;
  amount: number;
  qrData: string;
}

/** The Pix payment is what carries the BR Code, so `qr_data` is the payment's own code. */
function chargeFor(context: ServiceContext, draft: Draft, notify: string | null): Result<Charge, ErrorBody> {
  const created = createPayment(context, {
    transaction_amount: toDecimal(draft.totalMinor),
    payment_method_id: 'pix',
    description: draft.title ?? draft.externalReference,
    external_reference: draft.externalReference,
    payer: { email: QR_PAYER_EMAIL },
    ...(notify === null ? {} : { notification_url: notify }),
  });
  if (!created.ok) return created;
  if (!isJsonObject(created.value.body)) return err(badRequest('payment creation failed'));

  const body = created.value.body;
  const paymentId = readNumber(body, 'id');
  const qrData = readString(readObject(readObject(body, 'point_of_interaction'), 'transaction_data'), 'qr_code');
  if (paymentId === null || qrData === null) return err(badRequest('payment creation failed'));

  return ok({
    paymentId,
    status: readString(body, 'status') ?? 'pending',
    amount: readNumber(body, 'transaction_amount') ?? toDecimal(draft.totalMinor),
    qrData,
  });
}

/** Cancels the Pix payment and keeps the merchant order in step with the cancellation. */
function cancelCharge(context: ServiceContext, preferenceId: string, paymentId: number): string | null {
  const cancelled = updatePayment(context, String(paymentId), { status: 'cancelled' });
  if (!cancelled.ok || !isJsonObject(cancelled.value.body)) return null;

  const body = cancelled.value.body;
  const status = readString(body, 'status') ?? 'cancelled';
  attachPayment(context, preferenceId, paymentId, status, readNumber(body, 'transaction_amount') ?? 0);
  return status;
}

/** Frees the point of sale. An order still awaiting payment takes its Pix payment down. */
function release(context: ServiceContext, document: StoredDocument): void {
  const preferenceId = readString(document.doc, 'preference_id');
  const paymentId = readNumber(document.doc, 'payment_id');
  if (preferenceId !== null && paymentId !== null && readString(document.doc, 'payment_status') === 'pending') {
    cancelCharge(context, preferenceId, paymentId);
  }
  context.store.documents.remove('qr_order', document.id);
}

/** Reflects the current payment state back onto the merchant order and the QR order. */
function sync(context: ServiceContext, document: StoredDocument): StoredDocument {
  const preferenceId = readString(document.doc, 'preference_id');
  const paymentId = readNumber(document.doc, 'payment_id');
  if (preferenceId === null || paymentId === null) return document;

  const rendered = getPayment(context, String(paymentId));
  if (!rendered.ok || !isJsonObject(rendered.value.body)) return document;
  const payment = rendered.value.body;
  let paymentStatus = readString(payment, 'status') ?? 'pending';

  // The QR stops working at expiration_date even though the Pix payment lives longer,
  // so the order takes the payment down with it instead of leaving a dead code payable.
  const expired = document.expiresAt !== null && context.clock.now() >= document.expiresAt;
  if (expired && paymentStatus === 'pending') {
    paymentStatus = cancelCharge(context, preferenceId, paymentId) ?? paymentStatus;
  } else if (paymentStatus !== readString(document.doc, 'payment_status')) {
    // Re-attaching rewrites the entry's timestamps, so it only happens on a real change.
    attachPayment(context, preferenceId, paymentId, paymentStatus, readNumber(payment, 'transaction_amount') ?? 0);
  }

  const order = orderForPreference(context, preferenceId);
  const orderStatus = order === null ? 'payment_required' : (readString(order.doc, 'order_status') ?? 'payment_required');
  const status = orderStatus === 'paid' ? 'closed' : expired ? 'expired' : 'opened';

  const unchanged =
    document.status === status &&
    readString(document.doc, 'order_status') === orderStatus &&
    readString(document.doc, 'payment_status') === paymentStatus;
  if (unchanged) return document;

  const now = context.clock.now();
  const updated: StoredDocument = {
    ...document,
    status,
    updatedAt: now,
    doc: {
      ...document.doc,
      status,
      order_status: orderStatus,
      payment_status: paymentStatus,
      merchant_order_id: order === null ? null : order.sequence,
      last_updated: formatDateTime(now),
    },
  };
  context.store.documents.update(updated);
  return updated;
}

function createOrder(context: ServiceContext, ref: PosRef, body: unknown): Result<StoredDocument, ErrorBody> {
  const refused = checkRef(context, ref);
  if (refused !== null) return err(refused);

  const parsed = parse(body);
  if (!parsed.ok) return parsed;
  const draft = parsed.value;

  const notify = draft.notificationUrl ?? callbackUrl(context);
  const preference = preferenceFor(context, draft, notify);
  if (!preference.ok) return preference;

  const charge = chargeFor(context, draft, notify);
  if (!charge.ok) return charge;

  // The replacement exists before the POS is freed: a rejected request never takes the
  // live QR down with it.
  const existing = context.store.documents.get('qr_order', posKey(ref));
  if (existing !== null) release(context, sync(context, existing));

  attachPayment(context, preference.value, charge.value.paymentId, charge.value.status, charge.value.amount);
  const order = orderForPreference(context, preference.value);

  const now = context.clock.now();
  const document: StoredDocument = {
    kind: 'qr_order',
    id: posKey(ref),
    sequence: context.store.nextSequence('qr_order'),
    status: 'opened',
    externalReference: draft.externalReference,
    lookup: order === null ? null : String(order.sequence),
    createdAt: now,
    updatedAt: now,
    expiresAt: draft.expiresAt,
    doc: {
      id: context.ids.uuid(),
      external_reference: draft.externalReference,
      title: draft.title,
      description: draft.description,
      total_amount: toDecimal(draft.totalMinor),
      items: draft.items,
      cash_out: { amount: toDecimal(draft.cashOutMinor), status: 'pending' },
      collector_id: context.collectorId,
      external_store_id: ref.externalStoreId,
      external_pos_id: ref.externalPosId,
      qr_data: charge.value.qrData,
      preference_id: preference.value,
      payment_id: charge.value.paymentId,
      payment_status: charge.value.status,
      merchant_order_id: order === null ? null : order.sequence,
      status: 'opened',
      order_status: order === null ? 'payment_required' : (readString(order.doc, 'order_status') ?? 'payment_required'),
      notification_url: notify,
      expiration_date: draft.expirationDate,
      date_created: formatDateTime(now),
      last_updated: formatDateTime(now),
    },
  };

  context.store.documents.insert(document);
  return ok(document);
}

export function createInstoreOrder(
  context: ServiceContext,
  ref: PosRef,
  body: unknown,
): Result<Rendered, ErrorBody> {
  const created = createOrder(context, ref, body);
  return created.ok ? ok({ status: 200, body: created.value.doc }) : created;
}

/** The dynamic QR answers with the identifier and the BR Code alone. */
export function createDynamicQr(
  context: ServiceContext,
  ref: PosRef,
  body: unknown,
): Result<Rendered, ErrorBody> {
  const created = createOrder(context, ref, body);
  if (!created.ok) return created;
  return ok({
    status: 200,
    body: {
      in_store_order_id: readString(created.value.doc, 'id'),
      qr_data: readString(created.value.doc, 'qr_data'),
    },
  });
}

function locate(context: ServiceContext, ref: PosRef): Result<StoredDocument, ErrorBody> {
  const refused = checkRef(context, ref);
  if (refused !== null) return err(refused);
  const found = context.store.documents.get('qr_order', posKey(ref));
  return found === null ? err(notFound('Order not found')) : ok(sync(context, found));
}

export function getInstoreOrder(context: ServiceContext, ref: PosRef): Result<Rendered, ErrorBody> {
  const found = locate(context, ref);
  return found.ok ? ok({ status: 200, body: found.value.doc }) : found;
}

export function deleteInstoreOrder(context: ServiceContext, ref: PosRef): Result<Rendered, ErrorBody> {
  const found = locate(context, ref);
  if (!found.ok) return found;
  if (found.value.status === 'closed') {
    return err(invalid('a paid order cannot be deleted', 2015));
  }
  release(context, found.value);
  return ok({ status: 200, body: {} });
}

const CASHOUT_STATUSES: readonly string[] = ['confirmed', 'cancelled'];

export function confirmCashout(
  context: ServiceContext,
  merchantOrderId: string,
  body: unknown,
): Result<Rendered, ErrorBody> {
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));
  const status = readString(body, 'status');
  if (status === null || !CASHOUT_STATUSES.includes(status)) {
    return err(invalid('status must be confirmed or cancelled', 2012));
  }

  const found = context.store.documents.byLookup('qr_order', merchantOrderId);
  if (found === null) return err(notFound('Merchant order not found'));

  const document = sync(context, found);
  const current = readObject(document.doc, 'cash_out');
  if ((readNumber(current, 'amount') ?? 0) <= 0) {
    return err(invalid('the order carries no cash out', 2016));
  }
  if (CASHOUT_STATUSES.includes(readString(current, 'status') ?? '')) {
    return err(conflict('the cash out is already settled'));
  }

  const now = context.clock.now();
  const cashOut = { ...current, status };
  context.store.documents.update({
    ...document,
    updatedAt: now,
    doc: { ...document.doc, cash_out: cashOut, last_updated: formatDateTime(now) },
  });

  return ok({
    status: 200,
    body: {
      merchant_order_id: merchantOrderId,
      external_reference: document.externalReference,
      cash_out: cashOut,
      status,
      date_last_updated: formatDateTime(now),
    },
  });
}

const emptyConfig = (): JsonObject => ({
  callback_url: null,
  notification_url: null,
  date_created: null,
  last_updated: null,
});

export function getIntegratorConfig(context: ServiceContext): Result<Rendered, ErrorBody> {
  const found = context.store.documents.get('qr_config', CONFIG_ID);
  return ok({ status: 200, body: found === null ? emptyConfig() : found.doc });
}

export function updateIntegratorConfig(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));

  const patch: JsonObject = {};
  for (const key of ['callback_url', 'notification_url'] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (value !== null && (typeof value !== 'string' || !isHttpUrl(value))) {
      return err(invalid(`${key} must be an absolute http(s) URL`, 2013));
    }
    patch[key] = value;
  }

  const now = context.clock.now();
  const existing = context.store.documents.get('qr_config', CONFIG_ID);
  const doc: JsonObject = {
    ...(existing === null ? emptyConfig() : existing.doc),
    ...patch,
    date_created: existing === null ? formatDateTime(now) : (existing.doc['date_created'] ?? null),
    last_updated: formatDateTime(now),
  };

  if (existing === null) {
    context.store.documents.insert({
      kind: 'qr_config',
      id: CONFIG_ID,
      sequence: context.store.nextSequence('qr_config'),
      status: 'active',
      externalReference: null,
      lookup: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: null,
      doc,
    });
  } else {
    context.store.documents.update({ ...existing, updatedAt: now, doc });
  }

  return ok({ status: 200, body: doc });
}
