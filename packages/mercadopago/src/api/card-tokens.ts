import { type CardSnapshot, type JsonObject, type Result, type StoredDocument, err, ok } from '@payground/core';
import { type ErrorBody, badRequest, notFound } from '../errors.ts';
import { TEST_CARDS } from '../generated/tables.ts';
import type { CardToken } from '../generated/types.ts';
import { validateCardTokenRequest } from '../generated/validate.ts';
import { compact } from '../serialize/compact.ts';
import { formatDateTime } from '../serialize/datetime.ts';
import type { Rendered, ServiceContext } from './context.ts';

/**
 * Tokenisation is the only place raw card data appears, and payground never keeps it:
 * only the BIN, the last four digits, the expiry and the cardholder are persisted.
 * Real card data must never be sent here — payground is a sandbox, use the documented
 * test cards. https://www.mercadopago.com.br/developers/en/docs/your-integrations/test/cards
 */

/** Real tokens live ~7 days, and are consumed by the first payment that uses them. */
export const CARD_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type CardBrand = 'visa' | 'master' | 'amex' | 'elo' | 'hipercard';

/** Multi-function cards are billed through a separate debit catalogue code. */
const DEBIT_CODE: Partial<Record<CardBrand, string>> = {
  visa: 'debvisa',
  master: 'debmaster',
  elo: 'debelo',
};

const TEST_BRANDS: Record<string, CardBrand> = {
  Visa: 'visa',
  Mastercard: 'master',
  'American Express': 'amex',
  Elo: 'elo',
  Hipercard: 'hipercard',
};

const digitsOf = (value: string): string => value.replaceAll(/[^0-9]/g, '');

interface TestCardEntry {
  brand: CardBrand;
  debit: boolean;
}

const TEST_CARD_NUMBERS: ReadonlyMap<string, TestCardEntry> = new Map(
  TEST_CARDS.map((card) => {
    const brand = TEST_BRANDS[card.brand];
    if (brand === undefined) throw new Error(`unknown test card brand: ${card.brand}`);
    return [digitsOf(card.number), { brand, debit: card.type === 'Debit card' }] as const;
  }),
);

/**
 * Abridged BIN ranges: enough to classify the documented test cards and the prefixes a
 * Brazilian integration actually sees. Elo is checked before Mastercard because several
 * Elo ranges sit in the 50xxxx block.
 */
const BRAND_RANGES: readonly { brand: CardBrand; prefix: RegExp }[] = [
  { brand: 'amex', prefix: /^3[47]/ },
  { brand: 'hipercard', prefix: /^(?:606282|3841)/ },
  {
    brand: 'elo',
    prefix:
      /^(?:40117[89]|431274|438935|451416|457393|45763[12]|504175|506[67][0-9]{2}|509[0-9]{3}|627780|636297|636368|650[0-9]{3}|6516[5-9][0-9]|655[0-9]{3})/,
  },
  { brand: 'master', prefix: /^(?:5[1-5]|2(?:2[2-9]|[3-6][0-9]|7[01]|720))/ },
  { brand: 'visa', prefix: /^4/ },
];

const BRANDS: readonly string[] = ['visa', 'master', 'amex', 'elo', 'hipercard'];

export const isCardBrand = (value: string): value is CardBrand => BRANDS.includes(value);

export function brandFromBin(bin: string): CardBrand | null {
  return BRAND_RANGES.find((range) => range.prefix.test(bin))?.brand ?? null;
}

/** Catalogue code a resolved card defaults to, and the codes a caller may name for it. */
export function codesForBrand(brand: CardBrand, debit: boolean): { preferred: string; allowed: string[] } {
  const debitCode = DEBIT_CODE[brand];
  const allowed = debitCode === undefined ? [brand] : [brand, debitCode];
  return { preferred: debit && debitCode !== undefined ? debitCode : brand, allowed };
}

export function luhn(number: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = number.length - 1; index >= 0; index--) {
    let digit = number.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) return false;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return number.length > 0 && sum % 10 === 0;
}

const invalid = (description: string, code = 2062): ErrorBody =>
  badRequest('invalid card token', [{ code, description }]);

interface ParsedCard {
  bin: string;
  lastFour: string;
  expiryMonth: number;
  expiryYear: number;
  brand: CardBrand;
  debit: boolean;
  holderName: string;
  documentType: string | null;
  documentNumber: string | null;
}

/** Two digit years are what the checkout brick sends; four digit years come from SDKs. */
function normalizeYear(year: number): number {
  return year < 100 ? 2000 + year : year;
}

function parse(body: unknown, now: number): Result<ParsedCard, ErrorBody> {
  const validated = validateCardTokenRequest(body);
  if (!validated.ok) {
    return err(
      badRequest(
        'invalid parameters',
        validated.error.map((issue) => ({ code: 2034, description: `${issue.path}: ${issue.message}` })),
      ),
    );
  }
  const request = validated.value;

  const number = digitsOf(request.card_number);
  if (number.length < 13 || number.length > 19) {
    return err(invalid('card_number must have between 13 and 19 digits', 2005));
  }

  const known = TEST_CARD_NUMBERS.get(number);
  if (known === undefined && !luhn(number)) {
    return err(invalid('card_number failed the Luhn check', 2005));
  }

  const bin = number.slice(0, 6);
  const brand = known?.brand ?? brandFromBin(bin);
  if (brand === null) return err(invalid('card_number belongs to an unsupported brand', 2005));

  const month = request.expiration_month;
  if (month < 1 || month > 12) return err(invalid('expiration_month invalid', 2004));

  const year = normalizeYear(request.expiration_year);
  // A card is usable through the last instant of its expiry month.
  const expiresAt = Date.UTC(year, month, 1);
  if (expiresAt <= now) return err(invalid('the card is expired', 2004));

  const securityCode = digitsOf(request.security_code);
  const expected = brand === 'amex' ? 4 : 3;
  if (securityCode.length !== expected) {
    return err(invalid(`security_code must have ${expected} digits`, 2003));
  }

  const holderName = request.cardholder.name.trim();
  if (holderName === '') return err(invalid('cardholder.name is required', 2062));

  return ok({
    bin,
    lastFour: number.slice(-4),
    expiryMonth: month,
    expiryYear: year,
    brand,
    debit: known?.debit ?? false,
    holderName,
    documentType: request.cardholder.identification?.type ?? null,
    documentNumber: request.cardholder.identification?.number ?? null,
  });
}

function toDoc(card: ParsedCard): JsonObject {
  return {
    bin: card.bin,
    last_four: card.lastFour,
    expiration_month: card.expiryMonth,
    expiration_year: card.expiryYear,
    brand: card.brand,
    debit: card.debit,
    cardholder_name: card.holderName,
    identification_type: card.documentType,
    identification_number: card.documentNumber,
  };
}

export interface ResolvedCard {
  card: CardSnapshot;
  debit: boolean;
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asNumber = (value: unknown): number => (typeof value === 'number' ? value : 0);

function readCard(doc: JsonObject): ResolvedCard {
  return {
    card: {
      bin: asString(doc['bin']),
      lastFour: asString(doc['last_four']),
      expiryMonth: asNumber(doc['expiration_month']),
      expiryYear: asNumber(doc['expiration_year']),
      holderName: asString(doc['cardholder_name']),
      brand: asString(doc['brand']),
    },
    debit: doc['debit'] === true,
  };
}

type TokenStatus = NonNullable<CardToken['status']>;

function statusOf(document: StoredDocument, now: number): TokenStatus {
  if (document.status === 'used') return 'used';
  if (document.expiresAt !== null && now >= document.expiresAt) return 'expired';
  return 'active';
}

function serialize(document: StoredDocument, now: number): CardToken {
  const { card } = readCard(document.doc);
  const identificationType = document.doc['identification_type'];
  const identificationNumber = document.doc['identification_number'];
  const identification =
    typeof identificationNumber === 'string'
      ? { type: typeof identificationType === 'string' ? identificationType : 'CPF', number: identificationNumber }
      : undefined;

  return compact<CardToken>({
    id: document.id,
    first_six_digits: card.bin,
    last_four_digits: card.lastFour,
    expiration_month: card.expiryMonth,
    expiration_year: card.expiryYear,
    date_created: formatDateTime(document.createdAt),
    date_due: document.expiresAt === null ? undefined : formatDateTime(document.expiresAt),
    luhn_validation: true,
    status: statusOf(document, now),
    cardholder: compact<NonNullable<CardToken['cardholder']>>({
      name: card.holderName,
      identification,
    }),
  });
}

export function createCardToken(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  const now = context.clock.now();
  const parsed = parse(body, now);
  if (!parsed.ok) return parsed;

  const document: StoredDocument = {
    kind: 'card_token',
    // Opaque: the id carries no card data and is not derived from the PAN.
    id: context.ids.uuid().replaceAll('-', ''),
    sequence: context.store.nextSequence('card_token'),
    status: 'active',
    externalReference: null,
    lookup: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + CARD_TOKEN_TTL_MS,
    doc: toDoc(parsed.value),
  };
  context.store.documents.insert(document);

  return ok({ status: 201, body: serialize(document, now) });
}

export function getCardToken(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const document = context.store.documents.get('card_token', id);
  if (document === null) return err(notFound('Card token not found'));
  return ok({ status: 200, body: serialize(document, context.clock.now()) });
}

/** Resolves a token to its card and burns it. Tokens are strictly single-use. */
export function consumeCardToken(context: ServiceContext, id: string): Result<ResolvedCard, ErrorBody> {
  const now = context.clock.now();
  const document = context.store.documents.get('card_token', id);
  if (document === null) return err(invalid('card token not found'));

  const status = statusOf(document, now);
  if (status === 'used') return err(invalid('card token already used'));
  if (status === 'expired') return err(invalid('card token expired'));

  context.store.documents.update({ ...document, status: 'used', updatedAt: now });
  return ok(readCard(document.doc));
}
