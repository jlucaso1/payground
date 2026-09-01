import { type JsonObject, type Result, type StoredDocument, err, isJsonObject, ok } from '@payground/core';
import { escapeHtml } from '../checkout/html.ts';
import { type ErrorBody, badRequest, notFound, serverError } from '../errors.ts';
import type { POS, Store } from '../generated/types.ts';
import { validatePOSRequest, validateStoreRequest } from '../generated/validate.ts';
import { qrPng } from '../qr/index.ts';
import { compact } from '../serialize/compact.ts';
import { formatDateTime } from '../serialize/datetime.ts';
import type { Rendered, ServiceContext } from './context.ts';

/* ------------------------------------------------------------------ model */

type StoreDoc = {
  name: string;
  external_id: string | null;
  business_hours: Record<string, unknown> | null;
  location: Store['location'] | null;
};

type PosDoc = {
  name: string;
  store_id: string;
  external_id: string | null;
  external_store_id: string | null;
  category: number | null;
  fixed_amount: boolean;
  url: string | null;
};

/** Store and POS ids live in their own bands so neither is mistaken for a payment id. */
const STORE_BASE = 50_000_000;
const POS_BASE = 60_000_000;
const PAGE_CAP = 1000;

const readStore = (document: StoredDocument): StoreDoc => document.doc as unknown as StoreDoc;
const readPos = (document: StoredDocument): PosDoc => document.doc as unknown as PosDoc;
const asJson = (value: StoreDoc | PosDoc): JsonObject => value as unknown as JsonObject;

/* ------------------------------------------------------------------ errors */

const invalid = (description: string): ErrorBody =>
  badRequest('invalid parameters', [{ code: 'invalid_parameter', description }]);

function issues(list: readonly { path: string; message: string }[]): ErrorBody {
  return badRequest(
    'invalid parameters',
    list.map((issue) => ({ code: 'invalid_parameter', description: `${issue.path}: ${issue.message}` })),
  );
}

/**
 * The POS reference calls this `point_of_sale_exists`; payground answers 400 for both
 * resources because spec3.json declares no 409 for createPOS. See FIDELITY.md.
 */
const duplicate = (kind: 'store' | 'pos'): ErrorBody =>
  badRequest(kind === 'pos' ? 'point of sale already exists' : 'store already exists', [
    {
      code: kind === 'pos' ? 'point_of_sale_exists' : 'store_exists',
      description: 'external_id is already in use',
    },
  ]);

const STORE_NOT_FOUND = 'Store not found';
const POS_NOT_FOUND = 'POS not found';

/** `{user_id}` is the collector; another tenant's id must look empty, not forbidden. */
const owns = (context: ServiceContext, userId: string): boolean => userId === String(context.collectorId);

/* ------------------------------------------------------------------ parsing */

function parseExternalId(value: unknown, taken: (id: string) => boolean, kind: 'store' | 'pos'): Result<string | null, ErrorBody> {
  if (value === undefined) return ok(null);
  if (typeof value !== 'string') return err(invalid('external_id must be a string'));
  const external = value.trim();
  if (external === '') return err(invalid('external_id must not be empty'));
  if (/\s/.test(external)) return err(invalid('external_id must not contain whitespace'));
  if (taken(external)) return err(duplicate(kind));
  return ok(external);
}

const takenBy = (context: ServiceContext, kind: 'store' | 'pos', selfId: string | null) => (external: string): boolean => {
  const found = context.store.documents.byLookup(kind, external);
  return found !== null && found.id !== selfId;
};

function parseStoreBody(context: ServiceContext, body: unknown, selfId: string | null): Result<StoreDoc, ErrorBody> {
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));
  const validated = validateStoreRequest(body);
  if (!validated.ok) return err(issues(validated.error));

  const name = validated.value.name.trim();
  if (name === '') return err(invalid('name must not be empty'));

  const external = parseExternalId(body['external_id'], takenBy(context, 'store', selfId), 'store');
  if (!external.ok) return external;

  return ok({
    name,
    external_id: external.value,
    business_hours: validated.value.business_hours ?? null,
    location: validated.value.location ?? null,
  });
}

function parseStoreId(context: ServiceContext, value: unknown): Result<string, ErrorBody> {
  if (typeof value !== 'string' || value.trim() === '') return err(invalid('store_id must be a string'));
  const store = context.store.documents.get('store', value);
  if (store === null) return err(invalid('store_id not found'));
  return ok(store.id);
}

function parseCategory(value: unknown): Result<number | null, ErrorBody> {
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return err(invalid('category must be a non-negative integer'));
  }
  return ok(value);
}

function parseOptionalString(value: unknown, field: string): Result<string | null, ErrorBody> {
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== 'string') return err(invalid(`${field} must be a string`));
  return ok(value);
}

/* ------------------------------------------------------------------ rendering */

const origin = (context: ServiceContext): string => context.baseUrl.replace(/\/$/, '');

function renderStore(context: ServiceContext, document: StoredDocument): Store {
  const doc = readStore(document);
  return compact<Store>({
    id: document.id,
    user_id: context.collectorId,
    name: doc.name,
    external_id: doc.external_id,
    business_hours: doc.business_hours ?? undefined,
    location: doc.location ?? undefined,
    date_created: formatDateTime(document.createdAt),
    date_last_updated: formatDateTime(document.updatedAt),
  });
}

/** What the POS QR encodes, and the page it opens; both are served by this module. */
const qrLink = (context: ServiceContext, id: string): string => `${origin(context)}/pos/${id}/qr`;

function renderPos(context: ServiceContext, document: StoredDocument): POS {
  const doc = readPos(document);
  const link = qrLink(context, document.id);
  return compact<POS>({
    id: Number(document.id),
    user_id: context.collectorId,
    name: doc.name,
    store_id: doc.store_id,
    external_id: doc.external_id,
    external_store_id: doc.external_store_id,
    category: doc.category ?? undefined,
    fixed_amount: doc.fixed_amount,
    url: doc.url,
    status: document.status === 'inactive' ? 'inactive' : 'active',
    qr: { image: `${link}.png`, template_document: link, template_image: `${link}.png?scale=10` },
    qr_code: link,
    date_created: formatDateTime(document.createdAt),
    date_last_updated: formatDateTime(document.updatedAt),
  });
}

/* ------------------------------------------------------------------ paging */

interface Paging {
  limit: number;
  offset: number;
}

function paging(params: URLSearchParams): Paging {
  const limit = Number(params.get('limit') ?? 30);
  const offset = Number(params.get('offset') ?? 0);
  return {
    limit: Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), PAGE_CAP) : 30,
    offset: Number.isFinite(offset) ? Math.max(Math.trunc(offset), 0) : 0,
  };
}

function page<T>(matched: readonly StoredDocument[], bounds: Paging, render: (document: StoredDocument) => T): Rendered {
  return {
    status: 200,
    body: {
      paging: { total: matched.length, limit: bounds.limit, offset: bounds.offset },
      results: matched.slice(bounds.offset, bounds.offset + bounds.limit).map(render),
    },
  };
}

const all = (context: ServiceContext, kind: 'store' | 'pos'): readonly StoredDocument[] =>
  context.store.documents.search(kind, { limit: PAGE_CAP, offset: 0, order: 'asc' }).results;

/** A POS carries its store on `externalReference`, the only secondary index left for it. */
const posOfStore = (context: ServiceContext, storeId: string) =>
  context.store.documents.search('pos', { externalReference: storeId, limit: 1, offset: 0 });

const filter = (params: URLSearchParams, name: string): string | null => {
  const value = params.get(name);
  return value === null || value === '' ? null : value;
};

/* ------------------------------------------------------------------ stores */

export function createStore(context: ServiceContext, userId: string, body: unknown): Result<Rendered, ErrorBody> {
  if (!owns(context, userId)) return err(notFound(STORE_NOT_FOUND));

  const parsed = parseStoreBody(context, body, null);
  if (!parsed.ok) return parsed;

  const now = context.clock.now();
  const sequence = context.store.nextSequence('store');
  const document: StoredDocument = {
    kind: 'store',
    id: String(STORE_BASE + sequence),
    sequence,
    status: 'active',
    externalReference: null,
    lookup: parsed.value.external_id,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    doc: asJson(parsed.value),
  };

  context.store.documents.insert(document);
  return ok({ status: 201, body: renderStore(context, document) });
}

export function getStore(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const document = context.store.documents.get('store', id);
  if (document === null) return err(notFound(STORE_NOT_FOUND));
  return ok({ status: 200, body: renderStore(context, document) });
}

export function updateStore(
  context: ServiceContext,
  userId: string,
  id: string,
  body: unknown,
): Result<Rendered, ErrorBody> {
  if (!owns(context, userId)) return err(notFound(STORE_NOT_FOUND));
  const document = context.store.documents.get('store', id);
  if (document === null) return err(notFound(STORE_NOT_FOUND));

  const parsed = parseStoreBody(context, body, document.id);
  if (!parsed.ok) return parsed;

  const updated: StoredDocument = {
    ...document,
    updatedAt: context.clock.now(),
    lookup: parsed.value.external_id,
    doc: asJson(parsed.value),
  };
  context.store.documents.update(updated);
  return ok({ status: 200, body: renderStore(context, updated) });
}

export function deleteStore(context: ServiceContext, userId: string, id: string): Result<Rendered, ErrorBody> {
  if (!owns(context, userId)) return err(notFound(STORE_NOT_FOUND));
  const document = context.store.documents.get('store', id);
  if (document === null) return err(notFound(STORE_NOT_FOUND));

  // Refusing beats cascading: a cascade would silently destroy every QR of the store.
  if (posOfStore(context, document.id).total > 0) return err(invalid('the store still has points of sale'));

  context.store.documents.remove('store', document.id);
  return ok({ status: 200, body: {} });
}

export function searchStores(
  context: ServiceContext,
  userId: string,
  params: URLSearchParams,
): Result<Rendered, ErrorBody> {
  if (!owns(context, userId)) return err(notFound(STORE_NOT_FOUND));

  const bounds = paging(params);
  const external = filter(params, 'external_id');
  const matched = all(context, 'store').filter(
    (document) => external === null || readStore(document).external_id === external,
  );
  return ok(page(matched, bounds, (document) => renderStore(context, document)));
}

/* ------------------------------------------------------------------ points of sale */

export function createPOS(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));
  const validated = validatePOSRequest(body);
  if (!validated.ok) return err(issues(validated.error));

  const name = validated.value.name.trim();
  if (name === '') return err(invalid('name must not be empty'));

  const storeId = parseStoreId(context, body['store_id']);
  if (!storeId.ok) return storeId;

  const external = parseExternalId(body['external_id'], takenBy(context, 'pos', null), 'pos');
  if (!external.ok) return external;

  const rest = parseRest(body);
  if (!rest.ok) return rest;

  const now = context.clock.now();
  const sequence = context.store.nextSequence('pos');
  const document: StoredDocument = {
    kind: 'pos',
    id: String(POS_BASE + sequence),
    sequence,
    status: 'active',
    externalReference: storeId.value,
    lookup: external.value,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    doc: asJson({ name, store_id: storeId.value, external_id: external.value, ...rest.value }),
  };

  context.store.documents.insert(document);
  return ok({ status: 201, body: renderPos(context, document) });
}

type PosRest = Pick<PosDoc, 'external_store_id' | 'category' | 'fixed_amount' | 'url'>;

function parseRest(body: JsonObject): Result<PosRest, ErrorBody> {
  const externalStore = parseOptionalString(body['external_store_id'], 'external_store_id');
  if (!externalStore.ok) return externalStore;

  const category = parseCategory(body['category']);
  if (!category.ok) return category;

  const url = parseOptionalString(body['url'], 'url');
  if (!url.ok) return url;

  const fixed = body['fixed_amount'];
  if (fixed !== undefined && fixed !== null && typeof fixed !== 'boolean') {
    return err(invalid('fixed_amount must be a boolean'));
  }

  return ok({
    external_store_id: externalStore.value,
    category: category.value,
    fixed_amount: fixed === true,
    url: url.value,
  });
}

export function getPOS(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const document = context.store.documents.get('pos', id);
  if (document === null) return err(notFound(POS_NOT_FOUND));
  return ok({ status: 200, body: renderPos(context, document) });
}

export function updatePOS(context: ServiceContext, id: string, body: unknown): Result<Rendered, ErrorBody> {
  const document = context.store.documents.get('pos', id);
  if (document === null) return err(notFound(POS_NOT_FOUND));
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));

  const doc = readPos(document);

  const rawName = body['name'];
  if (rawName !== undefined && (typeof rawName !== 'string' || rawName.trim() === '')) {
    return err(invalid('name must be a non-empty string'));
  }

  let storeId = doc.store_id;
  if (body['store_id'] !== undefined) {
    const parsed = parseStoreId(context, body['store_id']);
    if (!parsed.ok) return parsed;
    storeId = parsed.value;
  }

  let external = doc.external_id;
  if (body['external_id'] !== undefined) {
    const parsed = parseExternalId(body['external_id'], takenBy(context, 'pos', document.id), 'pos');
    if (!parsed.ok) return parsed;
    external = parsed.value;
  }

  const rawStatus = body['status'];
  if (rawStatus !== undefined && rawStatus !== 'active' && rawStatus !== 'inactive') {
    return err(invalid('status must be active or inactive'));
  }

  const rest = parseRest({ ...asJson(doc), ...body });
  if (!rest.ok) return rest;

  const updated: StoredDocument = {
    ...document,
    status: rawStatus ?? document.status,
    updatedAt: context.clock.now(),
    externalReference: storeId,
    lookup: external,
    doc: asJson({
      name: typeof rawName === 'string' ? rawName.trim() : doc.name,
      store_id: storeId,
      external_id: external,
      ...rest.value,
    }),
  };

  context.store.documents.update(updated);
  return ok({ status: 200, body: renderPos(context, updated) });
}

export function deletePOS(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const document = context.store.documents.get('pos', id);
  if (document === null) return err(notFound(POS_NOT_FOUND));
  context.store.documents.remove('pos', document.id);
  return ok({ status: 200, body: {} });
}

function posMatches(document: StoredDocument, params: URLSearchParams): boolean {
  const doc = readPos(document);
  const external = filter(params, 'external_id');
  const externalStore = filter(params, 'external_store_id');
  const storeId = filter(params, 'store_id');
  const category = filter(params, 'category');
  const status = filter(params, 'status');
  return (
    (external === null || doc.external_id === external) &&
    (externalStore === null || doc.external_store_id === externalStore) &&
    (storeId === null || doc.store_id === storeId) &&
    (category === null || (doc.category !== null && String(doc.category) === category)) &&
    (status === null || document.status === status)
  );
}

export function searchPOS(context: ServiceContext, params: URLSearchParams): Result<Rendered, ErrorBody> {
  const bounds = paging(params);
  const matched = all(context, 'pos').filter((document) => posMatches(document, params));
  return ok(page(matched, bounds, (document) => renderPos(context, document)));
}

export function listPOS(
  context: ServiceContext,
  userId: string,
  params: URLSearchParams,
): Result<Rendered, ErrorBody> {
  if (!owns(context, userId)) return err(notFound(POS_NOT_FOUND));
  return searchPOS(context, params);
}

/* ------------------------------------------------------------------ qr */

const MAX_SCALE = 20;

function posFor(context: ServiceContext, id: string): Result<StoredDocument, ErrorBody> {
  const document = context.store.documents.get('pos', id);
  return document === null ? err(notFound(POS_NOT_FOUND)) : ok(document);
}

/** The PNG `qr.image` and `qr.template_image` point at. */
export function posQrPng(context: ServiceContext, id: string, scale: string | null): Result<Uint8Array, ErrorBody> {
  const document = posFor(context, id);
  if (!document.ok) return document;

  const requested = Number(scale ?? 4);
  const bounded = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), MAX_SCALE) : 4;
  const png = qrPng(qrLink(context, document.value.id), { scale: bounded });
  return png.ok ? ok(png.value) : err(serverError('qr unavailable'));
}

/**
 * `qr.template_document` is a printable PDF on the real API; payground serves the
 * equivalent page as HTML, because it renders no PDFs. See FIDELITY.md.
 */
export function posQrPage(context: ServiceContext, id: string): Result<{ status: number; html: string }, ErrorBody> {
  const document = posFor(context, id);
  if (!document.ok) return document;

  const doc = readPos(document.value);
  const store = context.store.documents.get('store', doc.store_id);
  const png = posQrPng(context, id, '10');
  if (!png.ok) return png;

  return ok({
    status: 200,
    html:
      '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>QR</title>' +
      '<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:32rem;text-align:center}' +
      'img{image-rendering:pixelated;width:20rem;height:20rem}</style></head><body>' +
      `<h1>${escapeHtml(doc.name)}</h1>` +
      `<p>${escapeHtml(store === null ? doc.store_id : readStore(store).name)}</p>` +
      `<img alt="POS QR code" src="data:image/png;base64,${Buffer.from(png.value).toString('base64')}">` +
      `<p><code>${escapeHtml(qrLink(context, document.value.id))}</code></p>` +
      '</body></html>',
  });
}
