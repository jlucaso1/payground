import { type JsonObject, type Result, type StoredDocument, err, isJsonObject, ok } from '@payground/core';
import { type ErrorBody, badRequest, notFound } from '../errors.ts';
import type { Address, Card, Customer, CustomerRequest, Identification, Phone } from '../generated/types.ts';
import {
  validateAddress,
  validateCustomerRequest,
  validateSaveCardRequest,
  validateUpdateCardRequest,
} from '../generated/validate.ts';
import { compact } from '../serialize/compact.ts';
import { formatDateTime } from '../serialize/datetime.ts';
import { type CardBrand, brandFromBin, codesForBrand, consumeCardToken, isCardBrand } from './card-tokens.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { readNumber, readObject, readString } from './document.ts';
import { PAYMENT_METHODS } from './payment-methods.ts';

const PAGE_CAP = 1000;
const CUSTOMER_BASE = 100_000_000;
const CARD_BASE = 1_500_000_000;
const ADDRESS_BASE = 1_000_000;

const resourceId = (uuid: string): string => uuid.replaceAll('-', '');

/** Emails are matched case-insensitively, so the lookup key is the folded form. */
const foldEmail = (email: string): string => email.trim().toLowerCase();

const invalid = (description: string, code = 2034): ErrorBody =>
  badRequest('invalid parameters', [{ code, description }]);

const issues = (found: { path: string; message: string }[]): ErrorBody =>
  badRequest(
    'invalid parameters',
    found.map((issue) => ({ code: 2034, description: `${issue.path}: ${issue.message}` })),
  );

/* ------------------------------------------------------------------ documents */

const normalizeYear = (year: number | null): number | null =>
  year === null || year >= 100 ? year : 2000 + year;

const nullableString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function phoneDoc(phone: Phone | undefined): JsonObject | null {
  if (phone === undefined) return null;
  return { area_code: phone.area_code ?? null, number: phone.number ?? null };
}

function identificationDoc(identification: Identification | undefined): JsonObject | null {
  if (identification === undefined) return null;
  return { type: identification.type ?? null, number: identification.number ?? null };
}

function addressFields(address: Address | undefined): JsonObject | null {
  if (address === undefined) return null;
  return {
    zip_code: address.zip_code ?? null,
    street_name: address.street_name ?? null,
    street_number: address.street_number ?? null,
    city: address.city ?? null,
    state: address.state ?? null,
    country: address.country ?? null,
    neighborhood: address.neighborhood ?? null,
    comments: address.comments ?? null,
  };
}

const optional = (value: string | null): string | undefined => value ?? undefined;

function serializePhone(doc: JsonObject): Phone | undefined {
  const area = readString(doc, 'area_code');
  const number = readString(doc, 'number');
  if (area === null && number === null) return undefined;
  return compact<Phone>({ area_code: optional(area), number: optional(number) });
}

function serializeIdentification(doc: JsonObject): Identification | undefined {
  const type = readString(doc, 'type');
  const number = readString(doc, 'number');
  if (type === null && number === null) return undefined;
  return compact<Identification>({ type: optional(type), number: optional(number) });
}

function serializeAddressFields(doc: JsonObject): Address {
  return compact<Address>({
    zip_code: optional(readString(doc, 'zip_code')),
    street_name: optional(readString(doc, 'street_name')),
    street_number: optional(readString(doc, 'street_number')),
    city: optional(readString(doc, 'city')),
    state: optional(readString(doc, 'state')),
    country: optional(readString(doc, 'country')),
    neighborhood: optional(readString(doc, 'neighborhood')),
    comments: optional(readString(doc, 'comments')),
  });
}

/* ------------------------------------------------------------------ cards */

function brandOf(doc: JsonObject): CardBrand | null {
  const brand = readString(doc, 'brand');
  if (brand !== null && isCardBrand(brand)) return brand;
  const bin = readString(doc, 'first_six_digits');
  return bin === null ? null : brandFromBin(bin);
}

function serializeCard(document: StoredDocument): Card {
  const doc = document.doc;
  const brand = brandOf(doc);
  const code = brand === null ? null : codesForBrand(brand, doc['debit'] === true).preferred;
  const method = PAYMENT_METHODS.find((entry) => entry.id === code);
  const securityCode = method?.settings[0]?.security_code;
  const identification = serializeIdentification(readObject(doc, 'identification'));

  return compact<Card>({
    id: document.id,
    customer_id: optional(readString(doc, 'customer_id')),
    first_six_digits: optional(readString(doc, 'first_six_digits')),
    last_four_digits: optional(readString(doc, 'last_four_digits')),
    expiration_month: readNumber(doc, 'expiration_month') ?? undefined,
    expiration_year: readNumber(doc, 'expiration_year') ?? undefined,
    date_created: formatDateTime(document.createdAt),
    date_last_updated: formatDateTime(document.updatedAt),
    cardholder: compact<NonNullable<Card['cardholder']>>({
      name: optional(readString(doc, 'cardholder_name')),
      identification,
    }),
    payment_method:
      method === undefined
        ? undefined
        : {
            id: method.id,
            name: method.name,
            payment_type_id: method.payment_type_id,
            thumbnail: method.thumbnail,
          },
    security_code:
      securityCode === undefined ? undefined : { mode: securityCode.mode, length: securityCode.length },
  });
}

const cardsOf = (context: ServiceContext, customerId: string): readonly StoredDocument[] =>
  context.store.documents.search('customer_card', { lookup: customerId, limit: PAGE_CAP, offset: 0, order: 'asc' })
    .results;

const addressesOf = (context: ServiceContext, customerId: string): readonly StoredDocument[] =>
  context.store.documents.search('customer_address', {
    lookup: customerId,
    limit: PAGE_CAP,
    offset: 0,
    order: 'asc',
  }).results;

/* ------------------------------------------------------------------ customers */

function serializeCustomer(context: ServiceContext, document: StoredDocument): Customer {
  const doc = document.doc;
  const metadata = doc['metadata'];
  const address = doc['address'];
  const phone = doc['phone'];
  const identification = doc['identification'];

  return compact<Customer>({
    id: document.id,
    email: optional(readString(doc, 'email')),
    first_name: optional(readString(doc, 'first_name')),
    last_name: optional(readString(doc, 'last_name')),
    phone: isJsonObject(phone) ? serializePhone(phone) : undefined,
    identification: isJsonObject(identification) ? serializeIdentification(identification) : undefined,
    address: isJsonObject(address) ? serializeAddressFields(address) : undefined,
    date_registered: formatDateTime(document.createdAt),
    date_created: formatDateTime(document.createdAt),
    date_last_updated: formatDateTime(document.updatedAt),
    description: optional(readString(doc, 'description')),
    metadata: isJsonObject(metadata) ? metadata : {},
    cards: cardsOf(context, document.id).map(serializeCard),
    default_card: optional(readString(doc, 'default_card')),
  });
}

function locate(context: ServiceContext, id: string): Result<StoredDocument, ErrorBody> {
  const document = context.store.documents.get('customer', id);
  return document === null ? err(notFound('Customer not found')) : ok(document);
}

const duplicate = (existing: StoredDocument): ErrorBody =>
  badRequest('Customer already exists', [
    { code: 101, description: 'customer already exist', data: existing.id },
  ]);

function customerDoc(request: CustomerRequest & { email: string }): JsonObject {
  return {
    email: request.email,
    first_name: request.first_name ?? null,
    last_name: request.last_name ?? null,
    phone: phoneDoc(request.phone),
    identification: identificationDoc(request.identification),
    address: addressFields(request.address),
    description: request.description ?? null,
    metadata: isJsonObject(request.metadata) ? request.metadata : {},
    default_card: null,
  };
}

export function createCustomer(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  const validated = validateCustomerRequest(body);
  if (!validated.ok) return err(issues(validated.error));

  const request = validated.value;
  const email = request.email;
  if (email === undefined || !email.includes('@')) return err(invalid('email must be a valid email address'));

  const key = foldEmail(email);
  const existing = context.store.documents.byLookup('customer', key);
  if (existing !== null) return err(duplicate(existing));

  const now = context.clock.now();
  const sequence = context.store.nextSequence('customer');
  const document: StoredDocument = {
    kind: 'customer',
    // The real id pairs the account's numeric id with an opaque suffix.
    id: `${CUSTOMER_BASE + sequence}-${resourceId(context.ids.uuid()).slice(0, 14)}`,
    sequence,
    status: 'active',
    externalReference: null,
    lookup: key,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    doc: customerDoc({ ...request, email: key }),
  };
  context.store.documents.insert(document);

  return ok({ status: 201, body: serializeCustomer(context, document) });
}

export function getCustomer(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const located = locate(context, id);
  if (!located.ok) return located;
  return ok({ status: 200, body: serializeCustomer(context, located.value) });
}

export function updateCustomer(context: ServiceContext, id: string, body: unknown): Result<Rendered, ErrorBody> {
  const located = locate(context, id);
  if (!located.ok) return located;

  const validated = validateCustomerRequest(body);
  if (!validated.ok) return err(issues(validated.error));
  const request = validated.value;

  const document = located.value;
  const current = document.doc;
  let lookup = document.lookup;

  if (request.email !== undefined) {
    if (!request.email.includes('@')) return err(invalid('email must be a valid email address'));
    const key = foldEmail(request.email);
    const clash = context.store.documents.byLookup('customer', key);
    if (clash !== null && clash.id !== document.id) return err(duplicate(clash));
    lookup = key;
  }

  const updated: StoredDocument = {
    ...document,
    lookup,
    updatedAt: context.clock.now(),
    doc: {
      ...current,
      email: request.email === undefined ? (current['email'] ?? null) : foldEmail(request.email),
      first_name: request.first_name ?? current['first_name'] ?? null,
      last_name: request.last_name ?? current['last_name'] ?? null,
      phone: phoneDoc(request.phone) ?? current['phone'] ?? null,
      identification: identificationDoc(request.identification) ?? current['identification'] ?? null,
      address: addressFields(request.address) ?? current['address'] ?? null,
      description: request.description ?? current['description'] ?? null,
      metadata: isJsonObject(request.metadata) ? request.metadata : (current['metadata'] ?? {}),
    },
  };
  context.store.documents.update(updated);

  return ok({ status: 200, body: serializeCustomer(context, updated) });
}

/** Deleting a customer takes its saved cards and addresses with it. */
export function deleteCustomer(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const located = locate(context, id);
  if (!located.ok) return located;

  const body = serializeCustomer(context, located.value);
  for (const card of cardsOf(context, id)) context.store.documents.remove('customer_card', card.id);
  for (const address of addressesOf(context, id)) context.store.documents.remove('customer_address', address.id);
  context.store.documents.remove('customer', id);

  return ok({ status: 200, body });
}

export function searchCustomers(context: ServiceContext, params: URLSearchParams): Result<Rendered, ErrorBody> {
  const rawLimit = Number(params.get('limit') ?? 30);
  const rawOffset = Number(params.get('offset') ?? 0);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), PAGE_CAP) : 30;
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;

  const email = params.get('email');
  // Nothing is filtered after the query, so the page is taken in SQL and stays reachable past PAGE_CAP.
  const found = context.store.documents.search('customer', {
    ...(email === null || email === '' ? {} : { lookup: foldEmail(email) }),
    limit,
    offset,
    order: 'asc',
  });

  return ok({
    status: 200,
    body: {
      paging: { total: found.total, limit, offset },
      results: found.results.map((document) => serializeCustomer(context, document)),
    },
  });
}

/* ------------------------------------------------------------------ saved cards */

function locateCard(
  context: ServiceContext,
  customerId: string,
  cardId: string,
): Result<StoredDocument, ErrorBody> {
  const located = locate(context, customerId);
  if (!located.ok) return located;
  const card = context.store.documents.get('customer_card', cardId);
  if (card === null || readString(card.doc, 'customer_id') !== customerId) {
    return err(notFound('Card not found'));
  }
  return ok(card);
}

function setDefaultCard(context: ServiceContext, customer: StoredDocument, cardId: string | null): void {
  context.store.documents.update({
    ...customer,
    updatedAt: context.clock.now(),
    doc: { ...customer.doc, default_card: cardId },
  });
}

export function saveCard(context: ServiceContext, customerId: string, body: unknown): Result<Rendered, ErrorBody> {
  const located = locate(context, customerId);
  if (!located.ok) return located;

  const validated = validateSaveCardRequest(body);
  if (!validated.ok) return err(issues(validated.error));

  const consumed = consumeCardToken(context, validated.value.token);
  if (!consumed.ok) return consumed;
  const { card, debit } = consumed.value;

  // The token document keeps the holder document, which the resolved snapshot drops.
  const token = context.store.documents.get('card_token', validated.value.token);
  const identification =
    token === null
      ? null
      : {
          type: nullableString(token.doc['identification_type']),
          number: nullableString(token.doc['identification_number']),
        };

  const now = context.clock.now();
  const sequence = context.store.nextSequence('customer_card');
  const document: StoredDocument = {
    kind: 'customer_card',
    id: String(CARD_BASE + sequence),
    sequence,
    status: 'active',
    externalReference: null,
    lookup: customerId,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    doc: {
      customer_id: customerId,
      first_six_digits: card.bin,
      last_four_digits: card.lastFour,
      expiration_month: card.expiryMonth,
      expiration_year: card.expiryYear,
      brand: card.brand,
      debit,
      cardholder_name: card.holderName,
      identification,
    },
  };
  context.store.documents.insert(document);

  // The first card a customer saves becomes the default one.
  if (readString(located.value.doc, 'default_card') === null) setDefaultCard(context, located.value, document.id);

  return ok({ status: 201, body: serializeCard(document) });
}

export function listCards(context: ServiceContext, customerId: string): Result<Rendered, ErrorBody> {
  const located = locate(context, customerId);
  if (!located.ok) return located;
  return ok({ status: 200, body: cardsOf(context, customerId).map(serializeCard) });
}

export function getCard(context: ServiceContext, customerId: string, cardId: string): Result<Rendered, ErrorBody> {
  const located = locateCard(context, customerId, cardId);
  if (!located.ok) return located;
  return ok({ status: 200, body: serializeCard(located.value) });
}

export function updateCard(
  context: ServiceContext,
  customerId: string,
  cardId: string,
  body: unknown,
): Result<Rendered, ErrorBody> {
  const located = locateCard(context, customerId, cardId);
  if (!located.ok) return located;

  const validated = validateUpdateCardRequest(body);
  if (!validated.ok) return err(issues(validated.error));
  const request = validated.value;

  const document = located.value;
  const current = document.doc;

  const month = request.expiration_month ?? readNumber(current, 'expiration_month');
  const year = normalizeYear(request.expiration_year ?? readNumber(current, 'expiration_year'));
  if (month === null || !Number.isInteger(month) || month < 1 || month > 12) {
    return err(invalid('expiration_month invalid', 2004));
  }
  // A card is usable through the last instant of its expiry month.
  if (year === null || !Number.isInteger(year) || Date.UTC(year, month, 1) <= context.clock.now()) {
    return err(invalid('expiration_year invalid', 2004));
  }

  const identification =
    request.cardholder?.identification === undefined
      ? (current['identification'] ?? null)
      : identificationDoc(request.cardholder.identification);

  const updated: StoredDocument = {
    ...document,
    updatedAt: context.clock.now(),
    doc: {
      ...current,
      expiration_month: month,
      expiration_year: year,
      cardholder_name: request.cardholder?.name ?? current['cardholder_name'] ?? null,
      identification,
    },
  };
  context.store.documents.update(updated);

  return ok({ status: 200, body: serializeCard(updated) });
}

/** Removing the default card promotes the oldest remaining one. */
export function deleteCard(context: ServiceContext, customerId: string, cardId: string): Result<Rendered, ErrorBody> {
  const located = locateCard(context, customerId, cardId);
  if (!located.ok) return located;

  const body = serializeCard(located.value);
  context.store.documents.remove('customer_card', cardId);

  const customer = context.store.documents.get('customer', customerId);
  if (customer !== null && readString(customer.doc, 'default_card') === cardId) {
    setDefaultCard(context, customer, cardsOf(context, customerId)[0]?.id ?? null);
  }

  return ok({ status: 200, body });
}

/* ------------------------------------------------------------------ addresses */

function serializeAddress(document: StoredDocument): Address {
  return compact<Address>({
    ...serializeAddressFields(document.doc),
    id: document.id,
    date_created: formatDateTime(document.createdAt),
    date_last_updated: formatDateTime(document.updatedAt),
  });
}

function locateAddress(
  context: ServiceContext,
  customerId: string,
  addressId: string,
): Result<StoredDocument, ErrorBody> {
  const located = locate(context, customerId);
  if (!located.ok) return located;
  const address = context.store.documents.get('customer_address', addressId);
  if (address === null || readString(address.doc, 'customer_id') !== customerId) {
    return err(notFound('Address not found'));
  }
  return ok(address);
}

export function createCustomerAddress(
  context: ServiceContext,
  customerId: string,
  body: unknown,
): Result<Rendered, ErrorBody> {
  const located = locate(context, customerId);
  if (!located.ok) return located;

  const validated = validateAddress(body);
  if (!validated.ok) return err(issues(validated.error));
  const fields = addressFields(validated.value);
  if (fields === null || readString(fields, 'zip_code') === null) return err(invalid('zip_code is required'));

  const now = context.clock.now();
  const sequence = context.store.nextSequence('customer_address');
  const document: StoredDocument = {
    kind: 'customer_address',
    id: String(ADDRESS_BASE + sequence),
    sequence,
    status: 'active',
    externalReference: null,
    lookup: customerId,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    doc: { ...fields, customer_id: customerId },
  };
  context.store.documents.insert(document);

  return ok({ status: 201, body: serializeAddress(document) });
}

export function listCustomerAddresses(context: ServiceContext, customerId: string): Result<Rendered, ErrorBody> {
  const located = locate(context, customerId);
  if (!located.ok) return located;
  return ok({ status: 200, body: addressesOf(context, customerId).map(serializeAddress) });
}

export function getCustomerAddress(
  context: ServiceContext,
  customerId: string,
  addressId: string,
): Result<Rendered, ErrorBody> {
  const located = locateAddress(context, customerId, addressId);
  if (!located.ok) return located;
  return ok({ status: 200, body: serializeAddress(located.value) });
}

export function updateCustomerAddress(
  context: ServiceContext,
  customerId: string,
  addressId: string,
  body: unknown,
): Result<Rendered, ErrorBody> {
  const located = locateAddress(context, customerId, addressId);
  if (!located.ok) return located;

  const validated = validateAddress(body);
  if (!validated.ok) return err(issues(validated.error));
  const request = validated.value;
  const document = located.value;
  const current = document.doc;

  const updated: StoredDocument = {
    ...document,
    updatedAt: context.clock.now(),
    doc: {
      ...current,
      zip_code: request.zip_code ?? current['zip_code'] ?? null,
      street_name: request.street_name ?? current['street_name'] ?? null,
      street_number: request.street_number ?? current['street_number'] ?? null,
      city: request.city ?? current['city'] ?? null,
      state: request.state ?? current['state'] ?? null,
      country: request.country ?? current['country'] ?? null,
      neighborhood: request.neighborhood ?? current['neighborhood'] ?? null,
      comments: request.comments ?? current['comments'] ?? null,
    },
  };
  context.store.documents.update(updated);

  return ok({ status: 200, body: serializeAddress(updated) });
}

export function deleteCustomerAddress(
  context: ServiceContext,
  customerId: string,
  addressId: string,
): Result<Rendered, ErrorBody> {
  const located = locateAddress(context, customerId, addressId);
  if (!located.ok) return located;

  const body = serializeAddress(located.value);
  context.store.documents.remove('customer_address', addressId);

  return ok({ status: 200, body });
}
