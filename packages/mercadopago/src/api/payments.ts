import {
  type Minor,
  type Payment,
  type PaymentCommand,
  type PaymentMethod,
  type PaymentQuery,
  type PaymentState,
  type Result,
  type Transition,
  apply,
  create,
  err,
  fromDecimal,
  isJsonObject,
  ok,
  paymentId,
  refundId,
  refundable,
  toDecimal,
} from '@payground/core';
import { type ErrorBody, badRequest, notFound, unprocessable } from '../errors.ts';
import { validatePaymentRequest } from '../generated/validate.ts';
import { type BoletoArtifacts, boletoArtifacts } from '../serialize/boleto.ts';
import { serializePayment } from '../serialize/payment.ts';
import { type PixArtifacts, pixArtifacts } from '../serialize/pix.ts';
import { type CardBrand, brandFromBin, codesForBrand, consumeCardToken, isCardBrand } from './card-tokens.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { decide } from './decision.ts';
import {
  PIX_DEFAULT_TTL_MS,
  PIX_MAX_TTL_MS,
  PIX_MIN_TTL_MS,
  VOUCHER_DEFAULT_TTL_MS,
  methodKind,
} from './methods.ts';

const SEQUENCE_BASE = 1_000_000_000;

/** The catalogue never offers more than 24 instalments in Brazil. */
const MAX_INSTALLMENTS = 24;

const pixSettings = (context: ServiceContext) => ({
  key: `${context.sandbox.id}@payground.local`,
  merchantName: 'PAYGROUND SANDBOX',
  merchantCity: 'SAO PAULO',
  baseUrl: context.baseUrl,
});

function artifacts(context: ServiceContext, payment: Payment, sequence: number): PixArtifacts | null {
  if (payment.method.code !== 'pix') return null;
  const made = pixArtifacts(payment, sequence, pixSettings(context));
  return made.ok ? made.value : null;
}

/** Bradesco is the default issuer for the documented `bolbradesco` method. */
const BOLETO_BANKS: Record<string, string> = { bolbradesco: '237', bolbradesco_pec: '237', pec: '237' };

function boleto(context: ServiceContext, payment: Payment, sequence: number): BoletoArtifacts | null {
  const bankCode = BOLETO_BANKS[payment.method.code];
  if (payment.method.kind !== 'voucher' || bankCode === undefined) return null;
  const made = boletoArtifacts(payment, sequence, { bankCode, baseUrl: context.baseUrl });
  return made.ok ? made.value : null;
}

function render(context: ServiceContext, payment: Payment, sequence: number): Rendered['body'] {
  const refunds = context.store.refunds
    .listFor(payment.id)
    .map((refund) => ({ refund, sequence: context.store.refunds.sequenceOf(refund.id) ?? 0 }));

  return serializePayment(payment, {
    sequence,
    collectorId: context.collectorId,
    liveMode: context.sandbox.liveMode,
    refunds,
    pix: artifacts(context, payment, sequence),
    boleto: boleto(context, payment, sequence),
  });
}

/** Expiry is applied on read, so a GET is correct even if the background tick is behind. */
export function materialize(context: ServiceContext, payment: Payment): Payment {
  if (payment.status.state !== 'pending' || payment.expiresAt === null) return payment;
  const now = context.clock.now();
  if (now < payment.expiresAt) return payment;

  const expired = apply(payment, { type: 'expire' }, now);
  if (!expired.ok) return payment;
  commit(context, expired.value, 'payment.updated');
  return expired.value.payment;
}

function commit(context: ServiceContext, transition: Transition, action: string): void {
  context.store.payments.update(transition.payment);
  context.store.payments.record(transition);
  const sequence = context.store.payments.sequenceOf(transition.payment.id);
  if (sequence !== null) {
    context.events.emit({
      type: 'payment',
      action,
      dataId: String(sequence),
      notificationUrl: transition.payment.notificationUrl,
    });
  }
}

interface ParsedRequest {
  amount: Minor;
  /** Absent when a card token carries the brand; resolved before the payment is built. */
  methodCode: string | null;
  token: string | null;
  email: string;
  documentType: string | null;
  documentNumber: string | null;
  description: string | null;
  externalReference: string | null;
  notificationUrl: string | null;
  metadata: Record<string, never> | Payment['metadata'];
  installments: number;
  binaryMode: boolean;
  capture: boolean;
  expiresAt: number | null;
}

function parse(body: unknown, now: number): Result<ParsedRequest, ErrorBody> {
  const validated = validatePaymentRequest(body);
  if (!validated.ok) {
    return err(
      badRequest(
        'invalid parameters',
        validated.error.map((issue) => ({ code: 2034, description: `${issue.path}: ${issue.message}` })),
      ),
    );
  }
  const request = validated.value;

  const amount = fromDecimal(request.transaction_amount ?? Number.NaN);
  if (!amount.ok || amount.value <= 0) {
    return err(badRequest('invalid parameters', [{ code: 3003, description: 'transaction_amount invalid' }]));
  }

  const token = request.token ?? null;
  const methodCode = request.payment_method_id ?? null;
  // A card token carries the brand, so payment_method_id is optional only when one is given.
  if (methodCode === null ? token === null : methodKind(methodCode) === null) {
    return err(badRequest('invalid parameters', [{ code: 3004, description: 'payment_method_id invalid' }]));
  }

  const email = request.payer?.email;
  if (email === undefined || !email.includes('@')) {
    return err(badRequest('invalid parameters', [{ code: 3001, description: 'payer.email invalid' }]));
  }

  const installments = request.installments ?? 1;
  if (!Number.isInteger(installments) || installments < 1 || installments > MAX_INSTALLMENTS) {
    return err(
      badRequest('invalid parameters', [
        { code: 3006, description: `installments must be an integer between 1 and ${MAX_INSTALLMENTS}` },
      ]),
    );
  }

  const kind = token === null && methodCode !== null ? methodKind(methodCode) : 'card';
  const ttl = kind === 'bank_transfer' ? PIX_DEFAULT_TTL_MS : VOUCHER_DEFAULT_TTL_MS;
  let expiresAt: number | null = kind === 'bank_transfer' || kind === 'voucher' ? now + ttl : null;

  if (request.date_of_expiration !== undefined && request.date_of_expiration !== null) {
    const parsed = Date.parse(request.date_of_expiration);
    if (Number.isNaN(parsed)) {
      return err(badRequest('invalid parameters', [{ code: 3005, description: 'date_of_expiration invalid' }]));
    }
    if (kind === 'bank_transfer' && (parsed - now < PIX_MIN_TTL_MS || parsed - now > PIX_MAX_TTL_MS)) {
      return err(
        badRequest('invalid parameters', [
          { code: 3005, description: 'date_of_expiration must be between 30 minutes and 30 days from now' },
        ]),
      );
    }
    expiresAt = parsed;
  }

  const metadata = isJsonObject(request.metadata) ? request.metadata : {};

  return ok({
    amount: amount.value,
    methodCode,
    token,
    email,
    documentType: request.payer?.identification?.type ?? null,
    documentNumber: request.payer?.identification?.number ?? null,
    description: request.description ?? null,
    externalReference: request.external_reference ?? null,
    notificationUrl: request.notification_url ?? null,
    metadata,
    installments,
    binaryMode: request.binary_mode ?? false,
    capture: request.capture ?? true,
    expiresAt,
  });
}

const brandMismatch = (code: string, brand: CardBrand): ErrorBody =>
  badRequest('invalid parameters', [
    { code: 3004, description: `payment_method_id ${code} does not match the card brand ${brand}` },
  ]);

/**
 * A card arrives only through a token: the token is consumed here, so a second attempt
 * with the same token fails exactly as it does against the real API.
 */
function resolveMethod(context: ServiceContext, request: ParsedRequest): Result<PaymentMethod, ErrorBody> {
  if (request.token === null) {
    const code = request.methodCode;
    const kind = code === null ? null : methodKind(code);
    if (code === null || kind === null) {
      return err(badRequest('invalid parameters', [{ code: 3004, description: 'payment_method_id invalid' }]));
    }
    if (kind === 'card') {
      return err(badRequest('invalid parameters', [{ code: 2062, description: 'card payments require a token' }]));
    }
    return ok({ kind, code, card: null });
  }

  const consumed = consumeCardToken(context, request.token);
  if (!consumed.ok) return consumed;
  const { card, debit } = consumed.value;

  const brand = isCardBrand(card.brand) ? card.brand : brandFromBin(card.bin);
  if (brand === null) {
    return err(badRequest('invalid parameters', [{ code: 3004, description: 'payment_method_id invalid' }]));
  }

  const { preferred, allowed } = codesForBrand(brand, debit);
  const code = request.methodCode ?? preferred;
  if (!allowed.includes(code)) return err(brandMismatch(code, brand));

  return ok({ kind: 'card', code, card });
}

export function createPayment(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  const now = context.clock.now();
  const parsed = parse(body, now);
  if (!parsed.ok) return parsed;
  const request = parsed.value;

  const resolved = resolveMethod(context, request);
  if (!resolved.ok) return resolved;
  const method = resolved.value;

  const decision = decide({ method, capture: request.capture, binaryMode: request.binaryMode });
  const sequence = SEQUENCE_BASE + context.store.nextSequence('payment');

  const payment = create(
    {
      id: paymentId(context.ids.uuid()),
      sandbox: context.sandbox.id,
      method,
      payer: {
        email: request.email,
        firstName: null,
        lastName: null,
        documentType: request.documentType,
        documentNumber: request.documentNumber,
      },
      amount: request.amount,
      currency: 'BRL',
      installments: request.installments,
      binaryMode: request.binaryMode,
      captureOnCreate: request.capture,
      description: request.description,
      externalReference: request.externalReference,
      notificationUrl: request.notificationUrl,
      metadata: request.metadata,
      expiresAt: request.expiresAt,
    },
    decision,
    now,
  );
  if (!payment.ok) {
    return err(unprocessable('invalid parameters', [{ code: 4037, description: payment.error.kind }]));
  }

  context.store.payments.insert(payment.value, sequence);
  context.events.emit({
    type: 'payment',
    action: 'payment.created',
    dataId: String(sequence),
    notificationUrl: payment.value.notificationUrl,
  });

  return ok({ status: 201, body: render(context, payment.value, sequence) });
}

function locate(context: ServiceContext, id: string): Result<{ payment: Payment; sequence: number }, ErrorBody> {
  const sequence = Number(id);
  if (!Number.isInteger(sequence)) return err(notFound());
  const found = context.store.payments.bySequence(sequence);
  if (found === null) return err(notFound());
  return ok({ payment: materialize(context, found), sequence });
}

export function getPayment(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const located = locate(context, id);
  if (!located.ok) return located;
  return ok({ status: 200, body: render(context, located.value.payment, located.value.sequence) });
}

const STATES: readonly PaymentState[] = [
  'pending', 'authorized', 'in_review', 'succeeded', 'failed', 'cancelled', 'refunded', 'in_mediation', 'charged_back',
];

const PROVIDER_TO_STATE: Record<string, PaymentState> = {
  pending: 'pending',
  authorized: 'authorized',
  in_process: 'in_review',
  approved: 'succeeded',
  rejected: 'failed',
  cancelled: 'cancelled',
  refunded: 'refunded',
  in_mediation: 'in_mediation',
  charged_back: 'charged_back',
};

export function searchPayments(context: ServiceContext, params: URLSearchParams): Result<Rendered, ErrorBody> {
  const query: PaymentQuery = {
    ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
    ...(params.has('offset') ? { offset: Number(params.get('offset')) } : {}),
    order: params.get('sort') === 'date_created' && params.get('criteria') === 'asc' ? 'asc' : 'desc',
    ...(params.has('external_reference') ? { externalReference: params.get('external_reference') as string } : {}),
    ...(params.has('payer.email') ? { payerEmail: params.get('payer.email') as string } : {}),
    ...(params.has('payment_method_id') ? { methodCode: params.get('payment_method_id') as string } : {}),
    ...(params.has('status') ? { states: statesFor(params.get('status') as string) } : {}),
  };

  const page = context.store.payments.search(query);
  const results = page.results.map((payment) => {
    const sequence = context.store.payments.sequenceOf(payment.id) ?? 0;
    const current = materialize(context, payment);
    const serialized = render(context, current, sequence);
    return isJsonObject(serialized as never) ? { ...(serialized as object), id: String(sequence) } : serialized;
  });

  return ok({
    status: 200,
    body: { paging: { total: page.total, limit: page.limit, offset: page.offset }, results },
  });
}

function statesFor(status: string): PaymentState[] {
  const mapped = status
    .split(',')
    .map((value) => PROVIDER_TO_STATE[value.trim()])
    .filter((value): value is PaymentState => value !== undefined);
  return mapped.length === 0 ? [...STATES] : mapped;
}

export function updatePayment(context: ServiceContext, id: string, body: unknown): Result<Rendered, ErrorBody> {
  const located = locate(context, id);
  if (!located.ok) return located;
  const { payment, sequence } = located.value;

  if (!isJsonObject(body as never)) return err(badRequest('the body must be a Json Object'));
  const patch = body as { status?: unknown; capture?: unknown; transaction_amount?: unknown };

  let command: PaymentCommand | null = null;
  if (patch.status === 'cancelled') command = { type: 'cancel', by: 'collector' };
  else if (patch.capture === true) {
    const requested = typeof patch.transaction_amount === 'number' ? fromDecimal(patch.transaction_amount) : null;
    if (requested !== null && !requested.ok) return err(badRequest('invalid transaction_amount'));
    command = { type: 'capture', amount: requested === null ? null : requested.value };
  }

  if (command === null) {
    return err(badRequest('invalid parameters', [{ code: 2001, description: 'nothing to update' }]));
  }

  const result = apply(payment, command, context.clock.now());
  if (!result.ok) {
    return err(unprocessable('operation not allowed', [{ code: 4051, description: result.error.kind }]));
  }

  commit(context, result.value, 'payment.updated');
  return ok({ status: 200, body: render(context, result.value.payment, sequence) });
}

export function createRefund(context: ServiceContext, id: string, body: unknown): Result<Rendered, ErrorBody> {
  const located = locate(context, id);
  if (!located.ok) return located;
  const { payment, sequence } = located.value;

  const raw = isJsonObject(body as never) ? (body as { amount?: unknown }) : {};
  const remaining = refundable(payment);
  let amount: Minor = remaining;

  if (raw.amount !== undefined) {
    if (typeof raw.amount !== 'number') return err(badRequest('invalid amount'));
    const parsed = fromDecimal(raw.amount);
    if (!parsed.ok) return err(badRequest('invalid amount'));
    amount = parsed.value;
  }

  const now = context.clock.now();
  const result = apply(payment, { type: 'refund', amount }, now);
  if (!result.ok) {
    return err(
      unprocessable('operation not allowed', [{ code: 2063, description: result.error.kind }]),
    );
  }

  const refundSequence = SEQUENCE_BASE + context.store.nextSequence('refund');
  const refund = {
    id: refundId(context.ids.uuid()),
    sandbox: context.sandbox.id,
    paymentId: payment.id,
    amount,
    status: 'approved' as const,
    partial: amount < remaining,
    createdAt: now,
  };

  context.store.refunds.insert(refund, refundSequence);
  commit(context, result.value, 'payment.updated');

  return ok({
    status: 201,
    body: {
      id: refundSequence,
      payment_id: sequence,
      amount: toDecimal(amount),
      source: { id: 'payground', name: 'payground', type: 'collector' },
      date_created: new Date(now).toISOString(),
      unique_sequence_number: null,
      refund_mode: 'standard',
      adjustment_amount: 0,
      status: 'approved',
      reason: null,
    },
  });
}

export function listRefunds(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const located = locate(context, id);
  if (!located.ok) return located;

  const refunds = context.store.refunds.listFor(located.value.payment.id).map((refund) => ({
    id: context.store.refunds.sequenceOf(refund.id) ?? 0,
    payment_id: located.value.sequence,
    amount: toDecimal(refund.amount),
    source: { id: 'payground', name: 'payground', type: 'collector' },
    date_created: new Date(refund.createdAt).toISOString(),
    unique_sequence_number: null,
    refund_mode: 'standard',
    adjustment_amount: 0,
    status: refund.status,
    reason: null,
  }));

  return ok({ status: 200, body: refunds });
}
