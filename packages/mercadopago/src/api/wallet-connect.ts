import {
  type JsonObject,
  type Minor,
  type Result,
  type StoredDocument,
  err,
  fromDecimal,
  isJsonObject,
  ok,
  toDecimal,
} from '@payground/core';
import { escapeHtml } from '../checkout/html.ts';
import { type ErrorBody, badRequest, notFound, unauthorized } from '../errors.ts';
import { compact } from '../serialize/compact.ts';
import { formatDateTime } from '../serialize/datetime.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { SITE_ID } from './preferences.ts';

/* ------------------------------------------------------------------ model */

/** Agreements, payer tokens and discount campaigns all live under the one document kind. */
const KIND = 'wallet_agreement';
const CODE = 2034;
const MODEL_VERSION = 1;
const CURRENCY = 'BRL';
const AGREEMENT_TTL_MS = 30 * 86_400_000;
const DEFAULT_SCOPES: readonly string[] = ['payment'];
const DEFAULT_TERMS = 'Discount granted by the seller. Not cumulative with other promotions.';

type AgreementStatus = 'pending' | 'active' | 'revoked' | 'expired';

interface AgreementDoc {
  record: 'agreement';
  external_flow_id: string;
  redirect_url: string;
  payer_email: string | null;
  mp_payer_id: number | null;
  scopes: string[];
  external_user: JsonObject | null;
  validation_amount: number | null;
  description: string | null;
  validation_code: string;
  /** Minted when the payer authorizes; exchanged for a payer token. */
  auth_code: string | null;
  date_expire: number;
  date_canceled: number | null;
}

interface TokenDoc {
  record: 'payer_token';
  agreement_id: string;
  token: string;
}

interface CampaignDoc {
  record: 'discount_campaign';
  coupon: string;
  /** Minor units; exactly one of `amount_off` and `percentage_bp` is set. */
  amount_off: number | null;
  /** Hundredths of a percent, so 12.5% is 1250. */
  percentage_bp: number | null;
  cap: number | null;
  valid_from: number;
  valid_to: number | null;
  max_uses: number | null;
  uses: number;
  description: string | null;
  legal_terms: string;
}

type Doc = AgreementDoc | TokenDoc | CampaignDoc;

const asJson = (value: Doc): JsonObject => value as unknown as JsonObject;
const record = (document: StoredDocument): string =>
  typeof document.doc['record'] === 'string' ? document.doc['record'] : '';
const readAgreement = (document: StoredDocument): AgreementDoc => document.doc as unknown as AgreementDoc;
const readToken = (document: StoredDocument): TokenDoc => document.doc as unknown as TokenDoc;
const readCampaign = (document: StoredDocument): CampaignDoc => document.doc as unknown as CampaignDoc;

const resourceId = (uuid: string): string => uuid.replaceAll('-', '');
const invalid = (description: string): ErrorBody => badRequest('invalid parameters', [{ code: CODE, description }]);

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const PAYER_BASE = 100_000_000;

/** Stable synthetic wallet payer id, so the same email always maps to the same number. */
function payerIdFor(email: string): number {
  let hash = 2166136261;
  for (let index = 0; index < email.length; index++) {
    hash ^= email.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return PAYER_BASE + ((hash >>> 0) % 900_000_000);
}

/* ------------------------------------------------------------------ agreements */

const agreementUri = (context: ServiceContext, id: string): string =>
  `${context.baseUrl}/wallet_connect/authorize/${id}`;

/** Expiry is not written back: an agreement reads as expired once its window closes. */
function statusOf(document: StoredDocument, now: number): AgreementStatus {
  const status = document.status as AgreementStatus;
  if (status === 'revoked') return 'revoked';
  return readAgreement(document).date_expire <= now ? 'expired' : status;
}

function loadAgreement(context: ServiceContext, id: string): Result<StoredDocument, ErrorBody> {
  const document = context.store.documents.get(KIND, id);
  if (document === null || record(document) !== 'agreement') return err(notFound('Agreement not found'));
  return ok(document);
}

function renderAgreement(context: ServiceContext, document: StoredDocument): JsonObject {
  const doc = readAgreement(document);
  const status = statusOf(document, context.clock.now());
  return compact<JsonObject>({
    id: document.id,
    agreement_id: document.id,
    status,
    external_flow_id: doc.external_flow_id,
    redirect_uri: doc.redirect_url,
    redirect_url: doc.redirect_url,
    agreement_uri: agreementUri(context, document.id),
    approval_uri: agreementUri(context, document.id),
    validation_code: doc.validation_code,
    scopes: doc.scopes,
    payer:
      doc.payer_email === null
        ? undefined
        : { email: doc.payer_email, mp_payer_id: doc.mp_payer_id },
    mp_payer_id: doc.mp_payer_id ?? undefined,
    external_user: doc.external_user ?? undefined,
    agreement_data:
      doc.validation_amount === null && doc.description === null
        ? undefined
        : compact<JsonObject>({
            validation_amount:
              doc.validation_amount === null ? undefined : toDecimal(doc.validation_amount as Minor),
            description: doc.description ?? undefined,
          }),
    site_id: SITE_ID,
    collector_id: context.collectorId,
    model_version: MODEL_VERSION,
    date_created: formatDateTime(document.createdAt),
    date_last_updated: formatDateTime(document.updatedAt),
    date_expire: formatDateTime(doc.date_expire),
    date_canceled: doc.date_canceled === null ? null : formatDateTime(doc.date_canceled),
  });
}

function parseScopes(value: unknown): Result<string[], ErrorBody> {
  if (value === undefined || value === null) return ok([...DEFAULT_SCOPES]);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    return err(invalid('scopes must be an array of non-empty strings'));
  }
  return ok(value as string[]);
}

export function createAgreement(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));

  const rawFlowId = body['external_flow_id'];
  if (typeof rawFlowId !== 'string' || rawFlowId.trim() === '') {
    return err(invalid('external_flow_id must be a non-empty string'));
  }
  const flowId = rawFlowId.trim();

  // The spec calls it `return_uri`; the wallet guides and integrators use `redirect_url`.
  const rawReturn = body['return_uri'] ?? body['redirect_url'];
  if (typeof rawReturn !== 'string' || !isHttpUrl(rawReturn)) {
    return err(invalid('return_uri must be an http(s) URL'));
  }

  const rawPayer = body['payer'];
  if (rawPayer !== undefined && !isJsonObject(rawPayer)) return err(invalid('payer must be an object'));
  const rawEmail = isJsonObject(rawPayer) ? rawPayer['email'] : undefined;
  if (rawEmail !== undefined && (typeof rawEmail !== 'string' || !rawEmail.includes('@'))) {
    return err(invalid('payer.email invalid'));
  }
  const email = typeof rawEmail === 'string' ? rawEmail : null;

  const scopes = parseScopes(body['scopes']);
  if (!scopes.ok) return scopes;

  const externalUser = body['external_user'];
  if (externalUser !== undefined && !isJsonObject(externalUser)) {
    return err(invalid('external_user must be an object'));
  }

  const agreementData = body['agreement_data'];
  if (agreementData !== undefined && !isJsonObject(agreementData)) {
    return err(invalid('agreement_data must be an object'));
  }
  let validationAmount: number | null = null;
  const rawValidation = isJsonObject(agreementData) ? agreementData['validation_amount'] : undefined;
  if (rawValidation !== undefined && rawValidation !== null) {
    if (typeof rawValidation !== 'number') return err(invalid('agreement_data.validation_amount must be a number'));
    const parsed = fromDecimal(rawValidation);
    if (!parsed.ok) return err(invalid('agreement_data.validation_amount must have at most two decimals'));
    validationAmount = parsed.value;
  }
  const rawDescription = isJsonObject(agreementData) ? agreementData['description'] : undefined;
  if (rawDescription !== undefined && typeof rawDescription !== 'string') {
    return err(invalid('agreement_data.description must be a string'));
  }

  const now = context.clock.now();
  const id = resourceId(context.ids.uuid());
  const document: StoredDocument = {
    kind: KIND,
    id,
    sequence: context.store.nextSequence(KIND),
    status: 'pending',
    externalReference: flowId,
    lookup: `flow:${flowId}`,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + AGREEMENT_TTL_MS,
    doc: asJson({
      record: 'agreement',
      external_flow_id: flowId,
      redirect_url: rawReturn,
      payer_email: email,
      mp_payer_id: email === null ? null : payerIdFor(email),
      scopes: scopes.value,
      external_user: isJsonObject(externalUser) ? externalUser : null,
      validation_amount: validationAmount,
      description: typeof rawDescription === 'string' ? rawDescription : null,
      validation_code: resourceId(context.ids.uuid()).slice(0, 6).toUpperCase(),
      auth_code: null,
      date_expire: now + AGREEMENT_TTL_MS,
      date_canceled: null,
    }),
  };

  context.store.documents.insert(document);
  return ok({ status: 200, body: renderAgreement(context, document) });
}

export function getAgreement(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const found = loadAgreement(context, id);
  if (!found.ok) return found;
  return ok({ status: 200, body: renderAgreement(context, found.value) });
}

/** Revocation is terminal: the agreement is never revived and its payer tokens stop working. */
export function deleteAgreement(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const found = loadAgreement(context, id);
  if (!found.ok) return found;
  const document = found.value;
  const now = context.clock.now();
  const status = statusOf(document, now);
  if (status === 'revoked') return ok({ status: 200, body: renderAgreement(context, document) });
  if (status === 'expired') return err(invalid('agreement is expired'));

  const revoked: StoredDocument = {
    ...document,
    status: 'revoked',
    updatedAt: now,
    doc: asJson({ ...readAgreement(document), date_canceled: now }),
  };
  context.store.documents.update(revoked);
  return ok({ status: 200, body: renderAgreement(context, revoked) });
}

/* ------------------------------------------------------------------ payer tokens */

const tokenLookup = (token: string): string => `token:${token}`;

export function createPayerToken(
  context: ServiceContext,
  agreementId: string,
  body: unknown,
): Result<Rendered, ErrorBody> {
  const found = loadAgreement(context, agreementId);
  if (!found.ok) return found;
  if (body !== undefined && !isJsonObject(body)) return err(badRequest('the body must be a Json Object'));

  const document = found.value;
  const doc = readAgreement(document);
  const now = context.clock.now();
  const status = statusOf(document, now);
  if (status !== 'active') return err(invalid(`agreement is ${status}`));

  // The redirect flow always hands the merchant a code, so the exchange demands it back.
  const code = isJsonObject(body) ? body['code'] : undefined;
  if (typeof code !== 'string' || code !== doc.auth_code) return err(invalid('code invalid'));

  const token = `WCT-${resourceId(context.ids.uuid())}`;
  const stored: StoredDocument = {
    kind: KIND,
    id: resourceId(context.ids.uuid()),
    sequence: context.store.nextSequence(KIND),
    status: 'active',
    externalReference: null,
    lookup: tokenLookup(token),
    createdAt: now,
    updatedAt: now,
    expiresAt: doc.date_expire,
    doc: asJson({ record: 'payer_token', agreement_id: document.id, token }),
  };
  context.store.documents.insert(stored);

  return ok({
    status: 200,
    body: compact<JsonObject>({
      payer_token: token,
      agreement_id: document.id,
      scopes: doc.scopes,
      // Extensions: a payment still needs the payer's email, which the real wallet resolves
      // from the token on its side.
      payer_email: doc.payer_email ?? undefined,
      mp_payer_id: doc.mp_payer_id ?? undefined,
      date_created: formatDateTime(now),
      date_expire: formatDateTime(doc.date_expire),
    }),
  });
}

interface PayerPrincipal {
  agreement: StoredDocument;
  token: string;
}

/** Resolves `x-payer-token`; a token of a revoked or expired agreement is no longer valid. */
function resolvePayer(context: ServiceContext, token: string | null): Result<PayerPrincipal, ErrorBody> {
  if (token === null || token.trim() === '') return err(unauthorized('x-payer-token is required'));
  const stored = context.store.documents.byLookup(KIND, tokenLookup(token.trim()));
  if (stored === null || record(stored) !== 'payer_token') return err(unauthorized('invalid payer token'));

  const agreement = context.store.documents.get(KIND, readToken(stored).agreement_id);
  if (agreement === null || record(agreement) !== 'agreement') return err(unauthorized('invalid payer token'));
  if (statusOf(agreement, context.clock.now()) !== 'active') return err(unauthorized('invalid payer token'));
  return ok({ agreement, token: token.trim() });
}

/* ------------------------------------------------------------------ discounts */

const couponLookup = (coupon: string): string => `coupon:${coupon}`;
const normaliseCoupon = (value: string): string => value.trim().toUpperCase();

type CouponStatus = 'active' | 'inactive' | 'expired';

function couponStatus(campaign: CampaignDoc, now: number): CouponStatus {
  if (campaign.valid_to !== null && now >= campaign.valid_to) return 'expired';
  if (now < campaign.valid_from) return 'inactive';
  if (campaign.max_uses !== null && campaign.uses >= campaign.max_uses) return 'inactive';
  return 'active';
}

/** Integer math on minor units: a percentage is held in hundredths of a percent. */
function discountFor(campaign: CampaignDoc, amount: Minor): Minor {
  const raw =
    campaign.amount_off !== null
      ? campaign.amount_off
      : Math.floor((amount * (campaign.percentage_bp ?? 0)) / 10_000);
  const capped = campaign.cap === null ? raw : Math.min(raw, campaign.cap);
  return Math.min(capped, amount) as Minor;
}

const campaignType = (campaign: CampaignDoc): string => (campaign.amount_off !== null ? 'fixed' : 'percentage');

function parseInstant(value: unknown, path: string): Result<number | null, ErrorBody> {
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== 'string') return err(invalid(`${path} must be a date-time string`));
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? err(invalid(`${path} must be a date-time string`)) : ok(parsed);
}

function parseAmount(value: unknown, path: string): Result<Minor, ErrorBody> {
  if (typeof value !== 'number') return err(invalid(`${path} must be a number`));
  const parsed = fromDecimal(value);
  if (!parsed.ok || parsed.value <= 0) {
    return err(invalid(`${path} must be a positive amount with at most two decimals`));
  }
  return ok(parsed.value);
}

function registerCampaign(
  context: ServiceContext,
  coupon: string,
  body: JsonObject,
): Result<Rendered, ErrorBody> {
  if (context.store.documents.byLookup(KIND, couponLookup(coupon)) !== null) {
    return err(invalid('coupon already registered'));
  }

  const rawAmount = body['discount_amount'];
  const rawPercentage = body['discount_percentage'];
  if (rawAmount !== undefined && rawPercentage !== undefined) {
    return err(invalid('discount_amount and discount_percentage are mutually exclusive'));
  }

  let amountOff: number | null = null;
  let percentageBp: number | null = null;
  if (rawAmount !== undefined) {
    const parsed = parseAmount(rawAmount, 'discount_amount');
    if (!parsed.ok) return parsed;
    amountOff = parsed.value;
  } else {
    if (typeof rawPercentage !== 'number' || rawPercentage <= 0 || rawPercentage > 100) {
      return err(invalid('discount_percentage must be a number between 0 and 100'));
    }
    const bp = Math.round(rawPercentage * 100);
    if (Math.abs(rawPercentage * 100 - bp) > 1e-6) {
      return err(invalid('discount_percentage must have at most two decimals'));
    }
    percentageBp = bp;
  }

  let cap: number | null = null;
  if (body['cap'] !== undefined && body['cap'] !== null) {
    const parsed = parseAmount(body['cap'], 'cap');
    if (!parsed.ok) return parsed;
    cap = parsed.value;
  }

  const from = parseInstant(body['valid_from'], 'valid_from');
  if (!from.ok) return from;
  const to = parseInstant(body['valid_to'], 'valid_to');
  if (!to.ok) return to;

  const now = context.clock.now();
  const validFrom = from.value ?? now;
  if (to.value !== null && to.value <= validFrom) return err(invalid('valid_to must be after valid_from'));

  let maxUses: number | null = null;
  const rawUses = body['max_uses'];
  if (rawUses !== undefined && rawUses !== null) {
    if (typeof rawUses !== 'number' || !Number.isInteger(rawUses) || rawUses < 1) {
      return err(invalid('max_uses must be a positive integer'));
    }
    maxUses = rawUses;
  }

  const description = body['description'];
  if (description !== undefined && typeof description !== 'string') {
    return err(invalid('description must be a string'));
  }
  const terms = body['legal_terms'];
  if (terms !== undefined && typeof terms !== 'string') return err(invalid('legal_terms must be a string'));

  const doc: CampaignDoc = {
    record: 'discount_campaign',
    coupon,
    amount_off: amountOff,
    percentage_bp: percentageBp,
    cap,
    valid_from: validFrom,
    valid_to: to.value,
    max_uses: maxUses,
    uses: 0,
    description: typeof description === 'string' ? description : null,
    legal_terms: typeof terms === 'string' ? terms : DEFAULT_TERMS,
  };

  const document: StoredDocument = {
    kind: KIND,
    id: resourceId(context.ids.uuid()),
    sequence: context.store.nextSequence(KIND),
    status: 'active',
    externalReference: null,
    lookup: couponLookup(coupon),
    createdAt: now,
    updatedAt: now,
    expiresAt: to.value,
    doc: asJson(doc),
  };
  context.store.documents.insert(document);
  return ok({ status: 201, body: renderCampaign(document, doc, couponStatus(doc, now)) });
}

function renderCampaign(document: StoredDocument, doc: CampaignDoc, status: CouponStatus): JsonObject {
  return compact<JsonObject>({
    coupon_id: doc.coupon,
    id: document.id,
    status,
    type: campaignType(doc),
    amount: doc.amount_off === null ? undefined : toDecimal(doc.amount_off as Minor),
    percentage: doc.percentage_bp === null ? undefined : doc.percentage_bp / 100,
    cap: doc.cap === null ? undefined : toDecimal(doc.cap as Minor),
    currency_id: CURRENCY,
    valid_from: formatDateTime(doc.valid_from),
    valid_to: doc.valid_to === null ? null : formatDateTime(doc.valid_to),
    max_uses: doc.max_uses,
    uses: doc.uses,
    description: doc.description ?? undefined,
    legal_terms: doc.legal_terms,
  });
}

/**
 * Registers a campaign when `discount_amount` or `discount_percentage` is present, and
 * otherwise quotes the spec's discount promise for `{ coupon, amount }`.
 */
export function createDiscount(
  context: ServiceContext,
  payerToken: string | null,
  body: unknown,
): Result<Rendered, ErrorBody> {
  const payer = resolvePayer(context, payerToken);
  if (!payer.ok) return payer;
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));

  const rawCoupon = body['coupon'] ?? body['id'];
  if (typeof rawCoupon !== 'string' || rawCoupon.trim() === '') {
    return err(invalid('coupon must be a non-empty string'));
  }
  const coupon = normaliseCoupon(rawCoupon);

  if (body['discount_amount'] !== undefined || body['discount_percentage'] !== undefined) {
    return registerCampaign(context, coupon, body);
  }

  const amount = parseAmount(body['amount'], 'amount');
  if (!amount.ok) return amount;

  const document = context.store.documents.byLookup(KIND, couponLookup(coupon));
  if (document === null || record(document) !== 'discount_campaign') return err(invalid('coupon not found'));

  const now = context.clock.now();
  const doc = readCampaign(document);
  const status = couponStatus(doc, now);
  if (status !== 'active') return err(invalid(`coupon is ${status}`));

  const discount = discountFor(doc, amount.value);
  // A promise consumes one of the campaign's uses; validation does not.
  context.store.documents.update({
    ...document,
    updatedAt: now,
    doc: asJson({ ...doc, uses: doc.uses + 1 }),
  });

  return ok({
    status: 200,
    body: {
      transaction_amount: toDecimal((amount.value - discount) as Minor),
      currency_id: CURRENCY,
      legal_terms: doc.legal_terms,
      discount: {
        amount: toDecimal(discount),
        type: campaignType(doc),
        coupon_id: doc.coupon,
      },
    },
  });
}

export function validateCoupon(
  context: ServiceContext,
  payerToken: string | null,
  body: unknown,
): Result<Rendered, ErrorBody> {
  const payer = resolvePayer(context, payerToken);
  if (!payer.ok) return payer;
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));

  const rawCoupon = body['id'] ?? body['coupon'];
  if (typeof rawCoupon !== 'string' || rawCoupon.trim() === '') {
    return err(invalid('id must be a non-empty string'));
  }

  const document = context.store.documents.byLookup(KIND, couponLookup(normaliseCoupon(rawCoupon)));
  if (document === null || record(document) !== 'discount_campaign') return err(invalid('coupon not found'));

  const doc = readCampaign(document);
  const status = couponStatus(doc, context.clock.now());

  let quote: JsonObject | undefined;
  if (body['amount'] !== undefined) {
    const amount = parseAmount(body['amount'], 'amount');
    if (!amount.ok) return amount;
    const discount = status === 'active' ? discountFor(doc, amount.value) : (0 as Minor);
    quote = {
      amount: toDecimal(discount),
      transaction_amount: toDecimal((amount.value - discount) as Minor),
      type: campaignType(doc),
    };
  }

  return ok({
    status: 200,
    body: compact<JsonObject>({
      status,
      description: doc.description ?? doc.coupon,
      legal_terms: doc.legal_terms,
      detail: compact<JsonObject>({
        ...renderCampaign(document, doc, status),
        discount: quote,
      }),
    }),
  });
}

/* ------------------------------------------------------------------ hosted authorization */

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
  '<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f5f6f8;color:#1a1a1a}' +
  'main{max-width:32rem;margin:0 auto;padding:2rem 1rem}' +
  '.card{background:#fff;border-radius:.5rem;padding:1rem 1.25rem;box-shadow:0 1px 2px rgba(0,0,0,.08)}' +
  'input{width:100%;padding:.5rem;margin:.25rem 0 1rem;box-sizing:border-box}' +
  'button{padding:.6rem 1rem;border:0;border-radius:.3rem;background:#009ee3;color:#fff;font-size:1rem}' +
  `</style></head><body><main><div class="card"><h1>${title}</h1>${body}</div></main></body></html>`;

export interface HostedPage {
  status: number;
  html: string;
}

const FALLBACK_EMAIL = 'test_user@testuser.com';

export function authorizePage(context: ServiceContext, id: string): Result<HostedPage, ErrorBody> {
  const found = loadAgreement(context, id);
  if (!found.ok) return found;
  const document = found.value;
  const doc = readAgreement(document);
  const status = statusOf(document, context.clock.now());

  if (status === 'revoked' || status === 'expired') {
    return ok({ status: 410, html: page('Agreement unavailable', `<p>This agreement is ${status}.</p>`) });
  }

  const email = escapeHtml(doc.payer_email ?? FALLBACK_EMAIL);
  return ok({
    status: 200,
    html: page(
      'Authorize wallet',
      `<p>Link your Mercado Pago wallet to <b>${escapeHtml(doc.external_flow_id)}</b>.</p>` +
        `<p>Scopes: ${escapeHtml(doc.scopes.join(', '))}</p>` +
        `<form method="post"><label>Email<input name="email" value="${email}"></label>` +
        '<button type="submit">Authorize</button></form>',
    ),
  });
}

export interface HostedSubmit extends HostedPage {
  redirect: string | null;
}

/** Authorizing mints the code the merchant exchanges for a payer token, MP's redirect flow. */
export function authorizeAgreement(
  context: ServiceContext,
  id: string,
  form: URLSearchParams,
): Result<HostedSubmit, ErrorBody> {
  const found = loadAgreement(context, id);
  if (!found.ok) return found;
  const document = found.value;
  const doc = readAgreement(document);
  const now = context.clock.now();
  const status = statusOf(document, now);
  if (status === 'revoked' || status === 'expired') {
    return ok({ status: 410, html: page('Agreement unavailable', `<p>This agreement is ${status}.</p>`), redirect: null });
  }

  const submitted = form.get('email');
  const email = submitted !== null && submitted.trim() !== '' ? submitted.trim() : doc.payer_email;
  if (email === null || !email.includes('@')) return err(invalid('payer.email invalid'));

  // Re-authorizing keeps the code already handed to the merchant but adopts the payer shown.
  const code = doc.auth_code ?? resourceId(context.ids.uuid());
  context.store.documents.update({
    ...document,
    status: 'active',
    updatedAt: now,
    doc: asJson({ ...doc, payer_email: email, mp_payer_id: payerIdFor(email), auth_code: code }),
  });

  const redirect = new URL(doc.redirect_url);
  redirect.searchParams.set('agreement_id', document.id);
  redirect.searchParams.set('external_flow_id', doc.external_flow_id);
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('status', 'authorized');

  return ok({ status: 303, html: page('Authorized', '<p>Agreement authorized.</p>'), redirect: redirect.toString() });
}
