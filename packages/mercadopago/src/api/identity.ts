import { createHmac } from 'node:crypto';
import { type Minor, type Result, err, fromDecimal, isJsonObject, minor, ok, toDecimal } from '@payground/core';
import { type ErrorBody, badRequest, errorBody } from '../errors.ts';
import { formatDateTime } from '../serialize/datetime.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { type PaymentMethodEntry, PAYMENT_METHODS } from './payment-methods.ts';

export interface IdentificationTypeEntry {
  id: string;
  name: string;
  type: string;
  min_length: number;
  max_length: number;
}

/**
 * The catalogue `GET /v1/identification_types` returns for a Brazilian (MLB) collector.
 * Committed as literal data so the sandbox answers exactly the same thing every run.
 * https://www.mercadopago.com.br/developers/en/reference/identification_types/_identification_types/get
 */
export const IDENTIFICATION_TYPES: readonly IdentificationTypeEntry[] = [
  { id: 'CPF', name: 'CPF', type: 'number', min_length: 11, max_length: 11 },
  { id: 'CNPJ', name: 'CNPJ', type: 'number', min_length: 14, max_length: 14 },
];

export function listIdentificationTypes(_context: ServiceContext): Result<Rendered, ErrorBody> {
  return ok({ status: 200, body: IDENTIFICATION_TYPES });
}

/** Instalments up to this count carry no interest; above it the price table below applies. */
const INTEREST_FREE_INSTALLMENTS = 6;

/** The catalogue never offers more than 12 instalments in Brazil. */
const MAX_INSTALLMENTS = 12;

/**
 * Buyer-financed instalments are charged at a fixed monthly rate on a price table
 * (`amount * i / (1 - (1 + i)^-n)`). 2.99% a month is the rate Mercado Pago publishes for
 * the seller who does not absorb the interest.
 * https://www.mercadopago.com.br/ajuda/custos-parcelamento-cartao_309
 */
const MONTHLY_RATE = 0.0299;

/** Only credit cards are financed: a Brazilian debit charge is always a single payment. */
const FINANCED_TYPE = 'credit_card';

/**
 * Real MLB issuer ids are per-account and are not published, so payground publishes one
 * stable virtual issuer per method instead. `issuer_id` on the query wins when given.
 */
const ISSUER_IDS: Record<string, string> = {
  visa: '1',
  master: '2',
  amex: '3',
  elo: '4',
  hipercard: '5',
  debvisa: '6',
  debmaster: '7',
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** `1234.5` becomes `1.234,50`, the notation the recommended message uses. */
function brl(value: Minor): string {
  const [whole = '0', cents = '00'] = toDecimal(value).toFixed(2).split('.');
  return `${whole.replaceAll(/\B(?=(\d{3})+(?!\d))/g, '.')},${cents}`;
}

const percent = (value: number): string => value.toFixed(2).replace('.', ',');

export interface PayerCost {
  installments: number;
  installment_rate: number;
  discount_rate: number;
  reimbursement_rate: number | null;
  labels: string[];
  installment_rate_collector: string[];
  min_allowed_amount: number;
  max_allowed_amount: number;
  recommended_message: string;
  installment_amount: number;
  total_amount: number;
  payment_method_option_id: string | null;
}

function payerCost(amount: Minor, installments: number, method: PaymentMethodEntry): PayerCost | null {
  const factor =
    installments <= INTEREST_FREE_INSTALLMENTS
      ? 1 / installments
      : MONTHLY_RATE / (1 - (1 + MONTHLY_RATE) ** -installments);

  // The instalment is the rounded unit and the total is its multiple, as on the real API.
  const each = minor(Math.round(amount * factor));
  if (!each.ok) return null;
  const total = minor(each.value * installments);
  if (!total.ok) return null;
  // The catalogue minimum applies to each instalment, not to the total.
  if (toDecimal(each.value) < method.min_allowed_amount) return null;

  const free = installments <= INTEREST_FREE_INSTALLMENTS;
  // An interest-free plan reports no rate even when rounding the instalment loses a cent.
  const rate = free ? 0 : round2((total.value / amount - 1) * 100);
  const annual = free ? 0 : ((1 + MONTHLY_RATE) ** 12 - 1) * 100;

  return {
    installments,
    installment_rate: rate,
    discount_rate: 0,
    reimbursement_rate: null,
    labels: [`CFT_${percent(rate)}%|TEA_${percent(annual)}%`],
    installment_rate_collector: ['MERCADOPAGO'],
    min_allowed_amount: method.min_allowed_amount,
    max_allowed_amount: method.max_allowed_amount,
    recommended_message: `${installments} ${installments === 1 ? 'parcela' : 'parcelas'} de R$ ${brl(each.value)} (R$ ${brl(total.value)})`,
    installment_amount: toDecimal(each.value),
    total_amount: toDecimal(total.value),
    payment_method_option_id: null,
  };
}

export function getInstallments(
  _context: ServiceContext,
  params: URLSearchParams,
): Result<Rendered, ErrorBody> {
  const methodId = params.get('payment_method_id')?.trim() ?? '';
  if (methodId === '') {
    return err(badRequest('payment_method_id is required', [
      { code: 'invalid_parameter', description: 'payment_method_id is required' },
    ]));
  }

  const method = PAYMENT_METHODS.find((entry) => entry.id === methodId);
  if (method === undefined) {
    return err(badRequest(`invalid payment_method_id: ${methodId}`, [
      { code: 'invalid_parameter', description: 'payment_method_id is not in the catalogue' },
    ]));
  }

  const rawAmount = params.get('amount')?.trim() ?? '';
  const parsed = rawAmount === '' ? Number.NaN : Number(rawAmount);
  const amount = fromDecimal(parsed);
  const ceiling = fromDecimal(method.max_allowed_amount);
  if (rawAmount === '' || !amount.ok || amount.value === 0) {
    return err(badRequest('amount is invalid', [
      { code: 'invalid_parameter', description: 'amount must be a positive decimal' },
    ]));
  }
  if (!ceiling.ok || amount.value > ceiling.value) {
    return err(badRequest(`amount is above the maximum for ${method.id}`, [
      { code: 'invalid_parameter', description: `amount must not exceed ${method.max_allowed_amount}` },
    ]));
  }

  const count = method.payment_type_id === FINANCED_TYPE ? MAX_INSTALLMENTS : 1;
  const costs: PayerCost[] = [];
  for (let installments = 1; installments <= count; installments += 1) {
    const cost = payerCost(amount.value, installments, method);
    if (cost !== null) costs.push(cost);
  }

  // An amount below the catalogue minimum buys nothing, so no option is offered at all.
  if (costs.length === 0) return ok({ status: 200, body: [] });

  const issuerId = params.get('issuer_id')?.trim() ?? '';
  return ok({
    status: 200,
    body: [
      {
        payment_method_id: method.id,
        payment_type_id: method.payment_type_id,
        issuer: {
          id: issuerId === '' ? ISSUER_IDS[method.id] ?? null : issuerId,
          name: method.name,
          secure_thumbnail: method.secure_thumbnail,
          thumbnail: method.thumbnail,
        },
        processing_mode: 'aggregator',
        merchant_account_id: null,
        payer_costs: costs,
        agreements: null,
      },
    ],
  });
}

/** Mercado Pago OAuth access tokens are valid for 180 days. */
const TOKEN_TTL_SECONDS = 15_552_000;
const SCOPE = 'offline_access read write';

const oauthError = (error: string, message: string): ErrorBody =>
  errorBody(400, error, message, [{ code: error, description: message }]);

const readString = (body: Record<string, unknown>, key: string): string | null => {
  const value = body[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
};

/**
 * There is nowhere to persist an OAuth grant — a sandbox holds a single credential pair —
 * so the refresh token is derived from the sandbox and validated by recomputation.
 */
export const refreshTokenFor = (context: ServiceContext): string =>
  `TG-${createHmac('sha256', context.sandbox.webhookSecret)
    .update(`oauth:${context.sandbox.accessToken}`)
    .digest('hex')
    .slice(0, 24)}-${context.collectorId}`;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/**
 * `client_secret` is the application's access token on the real API, so it doubles as the
 * credential that selects the sandbox. `client_id` is an application id payground has no
 * registry for: it must be present, and any value identifies the same application.
 * https://www.mercadopago.com.br/developers/en/reference/oauth/_oauth_token/post
 */
export function oauthClient(body: unknown, bearer: string | null): Result<OAuthClient, ErrorBody> {
  if (!isJsonObject(body)) return err(oauthError('invalid_request', 'the body must be a Json Object'));
  const clientId = readString(body, 'client_id');
  if (clientId === null) return err(oauthError('invalid_client', 'client_id is required'));
  const clientSecret = readString(body, 'client_secret') ?? bearer;
  if (clientSecret === null) return err(oauthError('invalid_client', 'client_secret is required'));
  return ok({ clientId, clientSecret });
}

/**
 * The minted access token is the sandbox's own credential: the only tokens the emulator
 * authenticates are the ones the sandbox registry holds, and the grant is meant to act on
 * that same sandbox.
 */
export function createOAuthToken(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  if (!isJsonObject(body)) return err(oauthError('invalid_request', 'the body must be a Json Object'));

  const grantType = readString(body, 'grant_type');
  if (grantType === 'authorization_code') {
    // Nothing hands out authorization codes here, so any non-empty code is honoured.
    if (readString(body, 'code') === null) {
      return err(oauthError('invalid_grant', 'code is required'));
    }
  } else if (grantType === 'refresh_token') {
    if (readString(body, 'refresh_token') !== refreshTokenFor(context)) {
      return err(oauthError('invalid_grant', 'invalid refresh_token'));
    }
  } else {
    return err(oauthError('unsupported_grant_type', `unsupported grant_type: ${grantType ?? 'null'}`));
  }

  return ok({
    status: 200,
    body: {
      access_token: context.sandbox.accessToken,
      token_type: 'bearer',
      expires_in: TOKEN_TTL_SECONDS,
      scope: SCOPE,
      user_id: context.collectorId,
      refresh_token: refreshTokenFor(context),
      public_key: context.sandbox.publicKey,
      live_mode: context.sandbox.liveMode,
    },
  });
}

const checkDigit = (digits: readonly number[]): number => {
  const sum = digits.reduce((acc, digit, index) => acc + digit * (digits.length + 1 - index), 0);
  const rest = (sum * 10) % 11;
  return rest === 10 ? 0 : rest;
};

/** A structurally valid CPF derived from the collector id, so it survives validation. */
function collectorCpf(collectorId: number): string {
  const base = String(collectorId).padStart(9, '0').slice(-9).split('').map(Number);
  const first = checkDigit(base);
  return [...base, first, checkDigit([...base, first])].join('');
}

/**
 * `GET /users/me` is absent from spec3.json but the official SDK's `user` client calls it,
 * so payground answers it. Shape from sdk-nodejs clients/user/get/types.ts.
 * https://github.com/mercadopago/sdk-nodejs — clients/user/get/types.ts
 */
export function getCollectorUser(context: ServiceContext): Result<Rendered, ErrorBody> {
  const id = context.collectorId;
  const nickname = `TESTUSER${id}`;
  return ok({
    status: 200,
    body: {
      id,
      nickname,
      registration_date: formatDateTime(context.sandbox.createdAt),
      first_name: 'Payground',
      last_name: 'Sandbox',
      gender: '',
      country_id: 'BR',
      email: `test_user_${id}@testuser.com`,
      secure_email: `${nickname}@mail.mercadolibre.com`,
      identification: { type: 'CPF', number: collectorCpf(id) },
      address: { address: null, city: null, state: null, zip_code: null },
      phone: { area_code: '11', extension: '', number: '999999999', verified: false },
      alternative_phone: { area_code: '', extension: '', number: '' },
      user_type: 'normal',
      tags: ['normal', 'test_user'],
      logo: null,
      points: 0,
      site_id: 'MLB',
      permalink: `https://www.mercadolivre.com.br/perfil/${nickname}`,
      seller_experience: 'ADVANCED',
      bill_data: { accept_credit_note: 'N' },
      registration_identifiers: [],
      status: {
        billing: { allow: true, codes: [] },
        buy: { allow: true, codes: [], immediate_payment: { reasons: [], required: false } },
        sell: { allow: true, codes: [], immediate_payment: { reasons: [], required: false } },
        list: { allow: true, codes: [], immediate_payment: { reasons: [], required: false } },
        confirmed_email: true,
        shopping_cart: { buy: 'allowed', sell: 'allowed' },
        immediate_payment: false,
        mercadoenvios: 'not_accepted',
        mercadopago_account_type: 'personal',
        mercadopago_tc_accepted: true,
        required_action: null,
        site_status: 'active',
        user_type: 'normal',
      },
    },
  });
}
