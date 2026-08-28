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
import { type ErrorBody, badRequest, notFound } from '../errors.ts';
import { validatePreferenceRequest } from '../generated/validate.ts';
import { formatDateTime } from '../serialize/datetime.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { readArray, readBoolean, readNumber, readObject, readObjects, readString } from './document.ts';

/** payground emulates the Brazilian site; the checkout return URL carries it back. */
export const SITE_ID = 'MLB';

const OPERATION_TYPE = 'regular_payment';
const DEFAULT_CURRENCY = 'BRL';
const MAX_EXTERNAL_REFERENCE = 256;

/** https://www.mercadopago.com.br/developers/en/reference/payment_methods/_payment_methods/get */
const PAYMENT_TYPES: readonly string[] = [
  'account_money',
  'ticket',
  'bank_transfer',
  'atm',
  'credit_card',
  'debit_card',
  'prepaid_card',
  'digital_currency',
  'digital_wallet',
  'voucher_card',
  'crypto_transfer',
];

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

function parseInstant(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

interface Draft {
  items: JsonObject[];
  totalMinor: Minor;
  payer: JsonObject;
  backUrls: { success: string; pending: string; failure: string };
  autoReturn: string | null;
  paymentMethods: JsonObject;
  shipments: JsonObject | null;
  shippingMinor: Minor;
  notificationUrl: string | null;
  statementDescriptor: string | null;
  additionalInfo: string | null;
  externalReference: string | null;
  expires: boolean;
  expirationFrom: string | null;
  expirationTo: string | null;
  marketplace: string;
  marketplaceFee: number;
  metadata: JsonObject;
  binaryMode: boolean;
  payerEmail: string | null;
}

function parseItems(raw: readonly unknown[]): Result<{ items: JsonObject[]; totalMinor: Minor }, ErrorBody> {
  if (raw.length === 0) return err(invalid('items must contain at least one item', 2001));

  const items: JsonObject[] = [];
  let total = 0;

  for (const [index, entry] of raw.entries()) {
    const item = entry as {
      id?: string;
      title: string;
      description?: string;
      picture_url?: string;
      category_id?: string;
      quantity: number;
      currency_id?: string;
      unit_price: number;
    };

    if (item.title.trim() === '') return err(invalid(`items[${index}].title must not be empty`, 2002));
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      return err(invalid(`items[${index}].quantity must be a positive integer`, 2003));
    }
    const price = fromDecimal(item.unit_price);
    if (!price.ok) return err(invalid(`items[${index}].unit_price invalid`, 2004));
    if (price.value === 0) return err(invalid(`items[${index}].unit_price must be greater than 0`, 2004));

    total += price.value * item.quantity;

    items.push({
      id: item.id ?? null,
      title: item.title,
      description: item.description ?? null,
      picture_url: item.picture_url ?? null,
      category_id: item.category_id ?? null,
      quantity: item.quantity,
      currency_id: item.currency_id ?? DEFAULT_CURRENCY,
      unit_price: toDecimal(price.value),
    });
  }

  const totalMinor = minor(total);
  if (!totalMinor.ok) return err(invalid('items total is too large', 2005));
  return ok({ items, totalMinor: totalMinor.value });
}

function parse(body: unknown): Result<Draft, ErrorBody> {
  const validated = validatePreferenceRequest(body);
  if (!validated.ok) {
    return err(
      badRequest(
        'invalid parameters',
        validated.error.map((issue) => ({ code: 2034, description: `${issue.path}: ${issue.message}` })),
      ),
    );
  }
  const request = validated.value;

  const parsedItems = parseItems(request.items);
  if (!parsedItems.ok) return parsedItems;

  const rawBackUrls = request.back_urls ?? {};
  for (const key of ['success', 'pending', 'failure'] as const) {
    const url = rawBackUrls[key];
    if (url !== undefined && url !== '' && !isHttpUrl(url)) {
      return err(invalid(`back_urls.${key} must be an absolute http(s) URL`, 2006));
    }
  }
  const backUrls = {
    success: rawBackUrls.success ?? '',
    pending: rawBackUrls.pending ?? '',
    failure: rawBackUrls.failure ?? '',
  };

  const autoReturn = request.auto_return ?? null;
  // The real API rejects auto_return without a success URL, with this exact message.
  // https://www.mercadopago.com.br/developers/en/docs/checkout-pro/checkout-customization/user-interface/redirection
  if (autoReturn !== null && backUrls.success === '') {
    return err(badRequest('invalid_auto_return', [{ code: 2011, description: 'auto_return invalid. back_url.success must be defined' }]));
  }

  if (request.notification_url !== undefined && !isHttpUrl(request.notification_url)) {
    return err(invalid('notification_url must be an absolute http(s) URL', 2007));
  }

  if (request.external_reference !== undefined && request.external_reference.length > MAX_EXTERNAL_REFERENCE) {
    return err(invalid(`external_reference must be at most ${MAX_EXTERNAL_REFERENCE} characters`, 2008));
  }

  const from = request.expiration_date_from ?? null;
  const to = request.expiration_date_to ?? null;
  const fromMs = from === null ? null : parseInstant(from);
  const toMs = to === null ? null : parseInstant(to);
  if (from !== null && fromMs === null) return err(invalid('expiration_date_from invalid', 2009));
  if (to !== null && toMs === null) return err(invalid('expiration_date_to invalid', 2009));
  if (fromMs !== null && toMs !== null && fromMs >= toMs) {
    return err(invalid('expiration_date_from must be earlier than expiration_date_to', 2009));
  }

  const excludedTypes = request.payment_methods?.excluded_payment_types ?? [];
  for (const excluded of excludedTypes) {
    if (excluded.id === undefined || !PAYMENT_TYPES.includes(excluded.id)) {
      return err(invalid(`payment_methods.excluded_payment_types.id ${String(excluded.id)} is unknown`, 2010));
    }
  }

  const rawMetadata = isJsonObject(body) ? body['metadata'] : undefined;
  if (rawMetadata !== undefined && !isJsonObject(rawMetadata)) {
    return err(invalid('metadata must be a Json object', 2013));
  }

  const shipmentCost = request.shipments?.cost;
  const shipping = shipmentCost === undefined ? ok(ZERO) : fromDecimal(shipmentCost);
  if (!shipping.ok) return err(invalid('shipments.cost invalid', 2012));

  return ok({
    items: parsedItems.value.items,
    totalMinor: parsedItems.value.totalMinor,
    payer: normalizePayer(request.payer),
    payerEmail: request.payer?.email ?? null,
    backUrls,
    autoReturn,
    paymentMethods: {
      excluded_payment_methods: (request.payment_methods?.excluded_payment_methods ?? []).map((entry) => ({
        id: entry.id ?? null,
      })),
      excluded_payment_types: excludedTypes.map((entry) => ({ id: entry.id ?? null })),
      installments: request.payment_methods?.installments ?? null,
      default_installments: request.payment_methods?.default_installments ?? null,
    },
    shipments: request.shipments === undefined ? null : (request.shipments as unknown as JsonObject),
    shippingMinor: shipping.value,
    notificationUrl: request.notification_url ?? null,
    statementDescriptor: request.statement_descriptor ?? null,
    additionalInfo: request.additional_info ?? null,
    externalReference: request.external_reference ?? null,
    expires: request.expires ?? false,
    expirationFrom: from,
    expirationTo: to,
    marketplace: request.marketplace ?? 'NONE',
    marketplaceFee: request.marketplace_fee ?? 0,
    metadata: rawMetadata ?? {},
    binaryMode: request.binary_mode ?? false,
  });
}

function normalizePayer(payer: unknown): JsonObject {
  const source = isJsonObject(payer) ? payer : {};
  return {
    name: source['name'] ?? null,
    surname: source['surname'] ?? null,
    email: source['email'] ?? null,
    phone: source['phone'] ?? null,
    identification: source['identification'] ?? null,
    address: source['address'] ?? null,
    date_created: source['date_created'] ?? null,
  };
}

/** Both point at this instance: payground *is* the sandbox, so there is no separate host. */
export const initPoint = (baseUrl: string, id: string): string =>
  `${baseUrl.replace(/\/$/, '')}/checkout/v1/redirect?pref_id=${encodeURIComponent(id)}`;

interface Meta {
  id: string;
  createdAt: number;
  updatedAt: number;
}

function render(context: ServiceContext, draft: Draft, meta: Meta): JsonObject {
  const point = initPoint(context.baseUrl, meta.id);
  return {
    id: meta.id,
    init_point: point,
    sandbox_init_point: point,
    collector_id: context.collectorId,
    client_id: String(context.collectorId),
    operation_type: OPERATION_TYPE,
    site_id: SITE_ID,
    processing_modes: ['aggregator'],
    live_mode: context.sandbox.liveMode,
    items: draft.items,
    payer: draft.payer,
    back_urls: draft.backUrls,
    auto_return: draft.autoReturn,
    payment_methods: draft.paymentMethods,
    shipments: draft.shipments,
    notification_url: draft.notificationUrl,
    statement_descriptor: draft.statementDescriptor,
    additional_info: draft.additionalInfo,
    external_reference: draft.externalReference,
    expires: draft.expires,
    expiration_date_from: draft.expirationFrom,
    expiration_date_to: draft.expirationTo,
    marketplace: draft.marketplace,
    marketplace_fee: draft.marketplaceFee,
    metadata: draft.metadata,
    binary_mode: draft.binaryMode,
    total_amount: toDecimal(draft.totalMinor),
    shipping_cost: toDecimal(draft.shippingMinor),
    sponsor_id: null,
    date_created: formatDateTime(meta.createdAt),
    last_updated: formatDateTime(meta.updatedAt),
  };
}

const expiresAtOf = (draft: Draft): number | null =>
  draft.expires && draft.expirationTo !== null ? parseInstant(draft.expirationTo) : null;

export function createPreference(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  const parsed = parse(body);
  if (!parsed.ok) return parsed;
  const draft = parsed.value;

  const now = context.clock.now();
  const id = `${context.collectorId}-${context.ids.uuid()}`;
  const doc = render(context, draft, { id, createdAt: now, updatedAt: now });

  context.store.documents.insert({
    kind: 'preference',
    id,
    sequence: context.store.nextSequence('preference'),
    status: 'active',
    externalReference: draft.externalReference,
    lookup: draft.payerEmail,
    createdAt: now,
    updatedAt: now,
    expiresAt: expiresAtOf(draft),
    doc,
  });

  return ok({ status: 201, body: doc });
}

export function getPreference(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const found = context.store.documents.get('preference', id);
  if (found === null) return err(notFound('Preference not found'));
  return ok({ status: 200, body: found.doc });
}

export function updatePreference(
  context: ServiceContext,
  id: string,
  body: unknown,
): Result<Rendered, ErrorBody> {
  const existing = context.store.documents.get('preference', id);
  if (existing === null) return err(notFound('Preference not found'));

  const parsed = parse(body);
  if (!parsed.ok) return parsed;
  const draft = parsed.value;

  const now = context.clock.now();
  const doc = render(context, draft, { id, createdAt: existing.createdAt, updatedAt: now });

  context.store.documents.update({
    ...existing,
    status: 'active',
    externalReference: draft.externalReference,
    lookup: draft.payerEmail,
    updatedAt: now,
    expiresAt: expiresAtOf(draft),
    doc,
  });

  return ok({ status: 200, body: doc });
}

/** The search endpoint answers with a trimmed element, not the whole preference. */
function element(document: StoredDocument, context: ServiceContext): JsonObject {
  const doc = document.doc;
  return {
    id: document.id,
    client_id: readString(doc, 'client_id'),
    collector_id: readNumber(doc, 'collector_id') ?? context.collectorId,
    date_created: readString(doc, 'date_created'),
    expiration_date_from: readString(doc, 'expiration_date_from'),
    expiration_date_to: readString(doc, 'expiration_date_to'),
    expires: readBoolean(doc, 'expires'),
    external_reference: document.externalReference,
    items: readArray(doc, 'items'),
    live_mode: doc['live_mode'] === true,
    marketplace: readString(doc, 'marketplace'),
    payer_email: readString(readObject(doc, 'payer'), 'email'),
    sponsor_id: null,
  };
}

export function searchPreferences(
  context: ServiceContext,
  params: URLSearchParams,
): Result<Rendered, ErrorBody> {
  const limit = params.has('limit') ? Number(params.get('limit')) : undefined;
  const offset = params.has('offset') ? Number(params.get('offset')) : undefined;
  if (limit !== undefined && !Number.isFinite(limit)) return err(invalid('limit invalid'));
  if (offset !== undefined && !Number.isFinite(offset)) return err(invalid('offset invalid'));

  const page = context.store.documents.search('preference', {
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
    ...(params.has('external_reference')
      ? { externalReference: params.get('external_reference') as string }
      : {}),
    ...(params.has('payer_email') ? { lookup: params.get('payer_email') as string } : {}),
    order: params.get('criteria') === 'asc' ? 'asc' : 'desc',
  });

  return ok({
    status: 200,
    body: {
      elements: page.results.map((document) => element(document, context)),
      next_offset: page.offset + page.results.length,
      total: page.total,
    },
  });
}

export interface PreferenceView {
  id: string;
  document: StoredDocument;
  items: JsonObject[];
  currency: string;
  totalMinor: Minor;
  shippingMinor: Minor;
  dueMinor: Minor;
  backUrls: { success: string; pending: string; failure: string };
  autoReturn: string | null;
  excludedTypes: readonly string[];
  externalReference: string | null;
  notificationUrl: string | null;
  metadata: JsonObject;
  payerEmail: string | null;
  expired: boolean;
}

const toMinor = (value: number): Minor => {
  const parsed = fromDecimal(value);
  return parsed.ok ? parsed.value : ZERO;
};

/** Shared read model for the merchant order and the hosted checkout page. */
export function preferenceView(document: StoredDocument, now: number): PreferenceView {
  const doc = document.doc;
  const items = readObjects(doc, 'items');
  const backUrls = readObject(doc, 'back_urls');
  const totalMinor = toMinor(readNumber(doc, 'total_amount') ?? 0);
  const shippingMinor = toMinor(readNumber(doc, 'shipping_cost') ?? 0);
  const from = readString(doc, 'expiration_date_from');
  const to = readString(doc, 'expiration_date_to');
  const fromMs = from === null ? null : parseInstant(from);
  const toMs = to === null ? null : parseInstant(to);

  return {
    id: document.id,
    document,
    items,
    currency: readString(items[0] ?? {}, 'currency_id') ?? DEFAULT_CURRENCY,
    totalMinor,
    shippingMinor,
    dueMinor: (totalMinor + shippingMinor) as Minor,
    backUrls: {
      success: readString(backUrls, 'success') ?? '',
      pending: readString(backUrls, 'pending') ?? '',
      failure: readString(backUrls, 'failure') ?? '',
    },
    autoReturn: readString(doc, 'auto_return'),
    excludedTypes: readObjects(readObject(doc, 'payment_methods'), 'excluded_payment_types')
      .map((entry) => readString(entry, 'id'))
      .filter((id): id is string => id !== null),
    externalReference: document.externalReference,
    notificationUrl: readString(doc, 'notification_url'),
    metadata: readObject(doc, 'metadata'),
    payerEmail: readString(readObject(doc, 'payer'), 'email'),
    expired:
      readBoolean(doc, 'expires') &&
      ((fromMs !== null && now < fromMs) || (toMs !== null && now >= toMs)),
  };
}

export function loadPreference(context: ServiceContext, id: string): PreferenceView | null {
  const document = context.store.documents.get('preference', id);
  return document === null ? null : preferenceView(document, context.clock.now());
}
