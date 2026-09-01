import {
  type JsonObject,
  type JsonValue,
  type Minor,
  type Result,
  type StoredDocument,
  err,
  fromDecimal,
  isJsonObject,
  ok,
  toDecimal,
} from '@payground/core';
import { type ErrorBody, badRequest, notFound, unprocessable } from '../errors.ts';
import type { AuthorizedPayment, AutoRecurring, Subscription, SubscriptionPlan } from '../generated/types.ts';
import {
  validateSubscriptionPlanRequest,
  validateSubscriptionRequest,
  validateSubscriptionUpdateRequest,
} from '../generated/validate.ts';
import { compact } from '../serialize/compact.ts';
import { formatDateTime } from '../serialize/datetime.ts';
import type { NotificationTopic, Rendered, ServiceContext } from './context.ts';
import { readString } from './document.ts';
import { createPayment } from './payments.ts';

/* ------------------------------------------------------------------ model */

type FrequencyType = 'days' | 'months';

/**
 * `billing_day` and `billing_day_proportional` are accepted by the real API but are absent
 * from the generated `AutoRecurring`, so they are read off the raw body and kept here.
 * https://www.mercadopago.com.br/developers/en/reference/subscriptions/_preapproval_plan/post
 */
type Recurrence = {
  frequency: number;
  frequency_type: FrequencyType;
  transaction_amount: number;
  currency_id: 'BRL';
  repetitions: number | null;
  billing_day: number | null;
  billing_day_proportional: boolean;
  free_trial: { frequency: number; frequency_type: FrequencyType } | null;
};

type PlanDoc = {
  reason: string;
  auto_recurring: Recurrence;
  back_url: string | null;
  notification_url: string | null;
  payment_methods_allowed: JsonValue;
};

type Proportional = { at: number; amount: number; charged: boolean };

type SubscriptionDoc = {
  preapproval_plan_id: string | null;
  reason: string;
  payer_email: string;
  payer_id: number;
  external_reference: string | null;
  back_url: string | null;
  notification_url: string | null;
  auto_recurring: Recurrence;
  payment_method_id: string | null;
  card_id: number | null;
  /** Epoch ms of the first full charge; null while the subscription is still pending. */
  anchor: number | null;
  /** Index of the next full cycle to charge, counted from `anchor`. */
  cycle: number;
  /** Full cycles actually charged; this is what `repetitions` caps. */
  installments: number;
  charged_amount: number;
  proportional: Proportional | null;
  retries: number;
};

type AuthorizedPaymentDoc = {
  preapproval_id: string;
  cycle: number;
  transaction_amount: number;
  payment_id: number | null;
  payment_status: string | null;
  payment_status_detail: string | null;
  status_detail: string;
  retries: number;
};

type WireRecurring = AutoRecurring & { billing_day?: number; billing_day_proportional?: boolean };
type WirePlan = Omit<SubscriptionPlan, 'auto_recurring'> & {
  auto_recurring?: WireRecurring;
  back_url?: string;
  payment_methods_allowed?: JsonValue;
};
type WireSubscription = Omit<Subscription, 'auto_recurring'> & {
  auto_recurring?: WireRecurring;
  back_url?: string;
};

type SubscriptionStatus = 'pending' | 'authorized' | 'paused' | 'cancelled';

const STATUSES: readonly SubscriptionStatus[] = ['pending', 'authorized', 'paused', 'cancelled'];

/**
 * Recurring charges are settled against the payer's balance: `createPayment` rejects card
 * codes without a token, and the token pipeline lives outside this module.
 */
const BILLING_METHOD = 'account_money';
const AUTHORIZED_PAYMENT_BASE = 1_000_000_000;
const PAGE_CAP = 1000;
/** A far future instant would otherwise charge a monthly plan forever. One run is bounded. */
const CYCLES_PER_RUN = 1000;
const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ events */

type SubscriptionTopic = Extract<NotificationTopic, `subscription_${string}`>;

/**
 * Subscriptions carry their own notification_url, and the topics ride it. Without one the
 * notice is still emitted so a test sink can observe it, but nothing is delivered.
 * https://www.mercadopago.com.br/developers/en/docs/subscriptions/additional-content/your-integrations/notifications/webhooks
 */
function emit(
  context: ServiceContext,
  type: SubscriptionTopic,
  action: string,
  dataId: string,
  notificationUrl: string | null = null,
): void {
  context.events.emit({ type, action, dataId, notificationUrl });
}

const notificationUrlOf = (document: StoredDocument): string | null =>
  readString(document.doc, 'notification_url') ?? null;

/* ------------------------------------------------------------------ dates */

const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** Adds whole periods keeping the time of day; a monthly step clamps to the month length. */
function addPeriod(epoch: number, count: number, type: FrequencyType, dayOfMonth: number | null): number {
  if (type === 'days') return epoch + count * DAY_MS;
  const base = new Date(epoch);
  const total = base.getUTCMonth() + count;
  const year = base.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const day = Math.min(dayOfMonth ?? base.getUTCDate(), daysInMonth(year, month));
  return Date.UTC(
    year,
    month,
    day,
    base.getUTCHours(),
    base.getUTCMinutes(),
    base.getUTCSeconds(),
    base.getUTCMilliseconds(),
  );
}

/** First occurrence of `billingDay` at or after `from`, clamped to the month length. */
function snapToBillingDay(from: number, billingDay: number): number {
  const base = new Date(from);
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const day = Math.min(billingDay, daysInMonth(year, month));
  const candidate = Date.UTC(
    year,
    month,
    day,
    base.getUTCHours(),
    base.getUTCMinutes(),
    base.getUTCSeconds(),
    base.getUTCMilliseconds(),
  );
  return candidate >= from ? candidate : addPeriod(from, 1, 'months', billingDay);
}

const dueAt = (doc: SubscriptionDoc, cycle: number): number =>
  doc.anchor === null
    ? Number.POSITIVE_INFINITY
    : addPeriod(doc.anchor, cycle * doc.auto_recurring.frequency, doc.auto_recurring.frequency_type, doc.auto_recurring.billing_day);

const exhausted = (doc: SubscriptionDoc): boolean =>
  doc.auto_recurring.repetitions !== null && doc.installments >= doc.auto_recurring.repetitions;

/**
 * Schedule of a subscription authorized at `startedAt`. A free trial pushes the first charge
 * to the end of the trial; a billing day moves it to that day of the month and, when
 * `billing_day_proportional` is set, charges the days in between up front.
 * https://www.mercadopago.com.br/developers/en/docs/subscriptions/integration-configuration/subscription-with-plan
 */
function schedule(recurrence: Recurrence, startedAt: number): { anchor: number; proportional: Proportional | null } {
  const trial = recurrence.free_trial;
  const afterTrial =
    trial === null ? startedAt : addPeriod(startedAt, trial.frequency, trial.frequency_type, null);

  if (recurrence.billing_day === null) return { anchor: afterTrial, proportional: null };

  const anchor = snapToBillingDay(afterTrial, recurrence.billing_day);
  if (trial !== null || !recurrence.billing_day_proportional) return { anchor, proportional: null };

  const start = new Date(startedAt);
  const span = Math.round((anchor - startedAt) / DAY_MS);
  const period = daysInMonth(start.getUTCFullYear(), start.getUTCMonth());
  const full = amountOf(recurrence);
  const amount = Math.round((full * span) / period);
  return { anchor, proportional: amount > 0 ? { at: startedAt, amount, charged: false } : null };
}

/* ------------------------------------------------------------------ parsing */

const CODE = 2034;
const invalid = (description: string): ErrorBody =>
  badRequest('invalid parameters', [{ code: CODE, description }]);

const amountOf = (recurrence: Recurrence): number => {
  const parsed = fromDecimal(recurrence.transaction_amount);
  return parsed.ok ? parsed.value : 0;
};

function issues(list: readonly { path: string; message: string }[]): ErrorBody {
  return badRequest(
    'invalid parameters',
    list.map((issue) => ({ code: CODE, description: `${issue.path}: ${issue.message}` })),
  );
}

function parseRecurrence(value: unknown, path: string): Result<Recurrence, ErrorBody> {
  if (!isJsonObject(value)) return err(invalid(`${path} must be an object`));

  const frequency = value['frequency'];
  if (typeof frequency !== 'number' || !Number.isInteger(frequency) || frequency < 1) {
    return err(invalid(`${path}.frequency must be a positive integer`));
  }

  const frequencyType = value['frequency_type'];
  if (frequencyType !== 'days' && frequencyType !== 'months') {
    return err(invalid(`${path}.frequency_type must be days or months`));
  }

  const rawAmount = value['transaction_amount'];
  if (typeof rawAmount !== 'number') return err(invalid(`${path}.transaction_amount must be a number`));
  const amount = fromDecimal(rawAmount);
  if (!amount.ok || amount.value <= 0) {
    return err(invalid(`${path}.transaction_amount must be a positive amount with at most two decimals`));
  }

  // payground settles every charge through `createPayment`, which mints BRL payments only.
  if (value['currency_id'] !== 'BRL') return err(invalid(`${path}.currency_id must be BRL`));

  const rawRepetitions = value['repetitions'];
  let repetitions: number | null = null;
  if (rawRepetitions !== undefined && rawRepetitions !== null) {
    if (typeof rawRepetitions !== 'number' || !Number.isInteger(rawRepetitions) || rawRepetitions < 1) {
      return err(invalid(`${path}.repetitions must be a positive integer`));
    }
    repetitions = rawRepetitions;
  }

  const rawBillingDay = value['billing_day'];
  let billingDay: number | null = null;
  if (rawBillingDay !== undefined && rawBillingDay !== null) {
    if (typeof rawBillingDay !== 'number' || !Number.isInteger(rawBillingDay) || rawBillingDay < 1 || rawBillingDay > 31) {
      return err(invalid(`${path}.billing_day must be an integer between 1 and 31`));
    }
    if (frequencyType !== 'months') return err(invalid(`${path}.billing_day requires frequency_type months`));
    billingDay = rawBillingDay;
  }

  const rawProportional = value['billing_day_proportional'];
  if (rawProportional !== undefined && rawProportional !== null && typeof rawProportional !== 'boolean') {
    return err(invalid(`${path}.billing_day_proportional must be a boolean`));
  }
  const proportional = rawProportional === true;
  if (proportional && billingDay === null) {
    return err(invalid(`${path}.billing_day_proportional requires billing_day`));
  }

  const rawTrial = value['free_trial'];
  let freeTrial: Recurrence['free_trial'] = null;
  if (rawTrial !== undefined && rawTrial !== null) {
    if (!isJsonObject(rawTrial)) return err(invalid(`${path}.free_trial must be an object`));
    const trialFrequency = rawTrial['frequency'];
    if (typeof trialFrequency !== 'number' || !Number.isInteger(trialFrequency) || trialFrequency < 1) {
      return err(invalid(`${path}.free_trial.frequency must be a positive integer`));
    }
    const trialType = rawTrial['frequency_type'];
    if (trialType !== 'days' && trialType !== 'months') {
      return err(invalid(`${path}.free_trial.frequency_type must be days or months`));
    }
    freeTrial = { frequency: trialFrequency, frequency_type: trialType };
  }

  return ok({
    frequency,
    frequency_type: frequencyType,
    transaction_amount: rawAmount,
    currency_id: 'BRL',
    repetitions,
    billing_day: billingDay,
    billing_day_proportional: proportional,
    free_trial: freeTrial,
  });
}

/* ------------------------------------------------------------------ documents */

/** Documents of these kinds are only ever written by this module. */
const readPlan = (document: StoredDocument): PlanDoc => document.doc as unknown as PlanDoc;
const readSubscription = (document: StoredDocument): SubscriptionDoc =>
  document.doc as unknown as SubscriptionDoc;
const readAuthorized = (document: StoredDocument): AuthorizedPaymentDoc =>
  document.doc as unknown as AuthorizedPaymentDoc;
const asJson = (value: PlanDoc | SubscriptionDoc | AuthorizedPaymentDoc): JsonObject =>
  value as unknown as JsonObject;

const resourceId = (uuid: string): string => uuid.replaceAll('-', '');

const PAYER_BASE = 100_000_000;

/** Stable synthetic payer id, so the same email always maps to the same number. */
function payerIdFor(email: string): number {
  let hash = 2166136261;
  for (let index = 0; index < email.length; index++) {
    hash ^= email.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return PAYER_BASE + ((hash >>> 0) % 900_000_000);
}

function wireRecurring(recurrence: Recurrence): WireRecurring {
  return compact<WireRecurring>({
    frequency: recurrence.frequency,
    frequency_type: recurrence.frequency_type,
    transaction_amount: recurrence.transaction_amount,
    currency_id: recurrence.currency_id,
    repetitions: recurrence.repetitions ?? undefined,
    billing_day: recurrence.billing_day ?? undefined,
    billing_day_proportional: recurrence.billing_day === null ? undefined : recurrence.billing_day_proportional,
    free_trial: recurrence.free_trial ?? undefined,
  });
}

function renderPlan(context: ServiceContext, document: StoredDocument): WirePlan {
  const doc = readPlan(document);
  return compact<WirePlan>({
    id: document.id,
    reason: doc.reason,
    status: document.status === 'inactive' ? 'inactive' : 'active',
    auto_recurring: wireRecurring(doc.auto_recurring),
    payment_methods_allowed: doc.payment_methods_allowed ?? undefined,
    back_url: doc.back_url ?? undefined,
    notification_url: doc.notification_url ?? undefined,
    date_created: formatDateTime(document.createdAt),
    last_modified: formatDateTime(document.updatedAt),
    init_point: `${context.baseUrl}/subscriptions/checkout?preapproval_plan_id=${document.id}`,
  });
}

function renderSubscription(context: ServiceContext, document: StoredDocument): WireSubscription {
  const doc = readSubscription(document);
  const status = document.status as SubscriptionStatus;
  const recurrence = doc.auto_recurring;
  const charged = doc.installments + (doc.proportional?.charged === true ? 1 : 0);
  const pendingQuantity = recurrence.repetitions === null ? null : recurrence.repetitions - doc.installments;
  const running = status === 'authorized' || status === 'paused';
  const next = running && !exhausted(doc) && doc.anchor !== null ? nextChargeAt(doc) : null;

  return compact<WireSubscription>({
    id: document.id,
    payer_id: doc.payer_id,
    payer_email: doc.payer_email,
    preapproval_plan_id: doc.preapproval_plan_id ?? undefined,
    reason: doc.reason,
    external_reference: doc.external_reference ?? undefined,
    back_url: doc.back_url ?? undefined,
    notification_url: doc.notification_url ?? undefined,
    status,
    date_created: formatDateTime(document.createdAt),
    last_modified: formatDateTime(document.updatedAt),
    auto_recurring: wireRecurring(recurrence),
    summarized: compact<NonNullable<Subscription['summarized']>>({
      quotas: recurrence.repetitions ?? undefined,
      charged_quantity: charged,
      pending_charge_quantity: pendingQuantity ?? undefined,
      charged_amount: toDecimal(doc.charged_amount as Minor),
      pending_charge_amount:
        pendingQuantity === null ? undefined : toDecimal((pendingQuantity * amountOf(recurrence)) as Minor),
    }),
    next_payment_date: next === null ? undefined : formatDateTime(next),
    payment_method_id: doc.payment_method_id ?? undefined,
    card_id: doc.card_id ?? undefined,
    init_point: `${context.baseUrl}/subscriptions/checkout?preapproval_id=${document.id}`,
  });
}

/** The proportional charge, when still pending, comes before the first full cycle. */
function nextChargeAt(doc: SubscriptionDoc): number {
  const pending = doc.proportional;
  if (pending !== null && !pending.charged) return pending.at;
  return dueAt(doc, doc.cycle);
}

function renderAuthorized(document: StoredDocument): AuthorizedPayment {
  const doc = readAuthorized(document);
  return compact<AuthorizedPayment>({
    id: document.sequence,
    preapproval_id: doc.preapproval_id,
    status: document.status as NonNullable<AuthorizedPayment['status']>,
    status_detail: doc.status_detail,
    date_created: formatDateTime(document.createdAt),
    last_modified: formatDateTime(document.updatedAt),
    transaction_amount: doc.transaction_amount,
    currency_id: 'BRL',
    payment:
      doc.payment_id === null
        ? undefined
        : compact<NonNullable<AuthorizedPayment['payment']>>({
            id: doc.payment_id,
            status: doc.payment_status ?? undefined,
            status_detail: doc.payment_status_detail ?? undefined,
          }),
  });
}

/* ------------------------------------------------------------------ plans */

export function createPlan(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));
  const validated = validateSubscriptionPlanRequest(body);
  if (!validated.ok) return err(issues(validated.error));

  const reason = validated.value.reason.trim();
  if (reason === '') return err(invalid('reason must not be empty'));

  const recurrence = parseRecurrence(body['auto_recurring'], 'auto_recurring');
  if (!recurrence.ok) return recurrence;

  const now = context.clock.now();
  const document: StoredDocument = {
    kind: 'preapproval_plan',
    id: resourceId(context.ids.uuid()),
    sequence: context.store.nextSequence('preapproval_plan'),
    status: 'active',
    externalReference: null,
    lookup: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    doc: asJson({
      reason,
      auto_recurring: recurrence.value,
      back_url: validated.value.back_url ?? null,
      notification_url: validated.value.notification_url ?? null,
      payment_methods_allowed: (body['payment_methods_allowed'] ?? null) as JsonValue,
    }),
  };

  context.store.documents.insert(document);
  emit(context, 'subscription_preapproval_plan', 'created', document.id, notificationUrlOf(document));
  return ok({ status: 201, body: renderPlan(context, document) });
}

export function getPlan(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const document = context.store.documents.get('preapproval_plan', id);
  if (document === null) return err(notFound('Plan not found'));
  return ok({ status: 200, body: renderPlan(context, document) });
}

export function updatePlan(context: ServiceContext, id: string, body: unknown): Result<Rendered, ErrorBody> {
  const document = context.store.documents.get('preapproval_plan', id);
  if (document === null) return err(notFound('Plan not found'));
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));

  const doc = readPlan(document);
  let recurrence = doc.auto_recurring;
  if (body['auto_recurring'] !== undefined) {
    const parsed = parseRecurrence(body['auto_recurring'], 'auto_recurring');
    if (!parsed.ok) return parsed;
    recurrence = parsed.value;
  }

  const rawReason = body['reason'];
  if (rawReason !== undefined && (typeof rawReason !== 'string' || rawReason.trim() === '')) {
    return err(invalid('reason must be a non-empty string'));
  }

  const rawStatus = body['status'];
  if (rawStatus !== undefined && rawStatus !== 'active' && rawStatus !== 'inactive') {
    return err(invalid('status must be active or inactive'));
  }

  const rawBackUrl = body['back_url'];
  if (rawBackUrl !== undefined && typeof rawBackUrl !== 'string') {
    return err(invalid('back_url must be a string'));
  }

  const rawNotificationUrl = body['notification_url'];
  if (rawNotificationUrl !== undefined && typeof rawNotificationUrl !== 'string') {
    return err(invalid('notification_url must be a string'));
  }

  const updated: StoredDocument = {
    ...document,
    status: rawStatus ?? document.status,
    updatedAt: context.clock.now(),
    doc: asJson({
      reason: typeof rawReason === 'string' ? rawReason.trim() : doc.reason,
      auto_recurring: recurrence,
      back_url: rawBackUrl ?? doc.back_url,
      notification_url: rawNotificationUrl ?? doc.notification_url,
      payment_methods_allowed: (body['payment_methods_allowed'] ?? doc.payment_methods_allowed) as JsonValue,
    }),
  };

  context.store.documents.update(updated);
  emit(context, 'subscription_preapproval_plan', 'updated', updated.id, notificationUrlOf(updated));
  return ok({ status: 200, body: renderPlan(context, updated) });
}

interface Paging {
  limit: number;
  offset: number;
  order: 'asc' | 'desc';
}

function paging(params: URLSearchParams): Paging {
  const limit = Number(params.get('limit') ?? 30);
  const offset = Number(params.get('offset') ?? 0);
  return {
    limit: Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), PAGE_CAP) : 30,
    offset: Number.isFinite(offset) ? Math.max(Math.trunc(offset), 0) : 0,
    order: params.get('criteria') === 'asc' || params.get('sort') === 'date_created:asc' ? 'asc' : 'desc',
  };
}

/**
 * Only status, external_reference and lookup are indexed; the remaining filters are applied
 * over a capped page so `paging.total` still reflects the filtered set.
 */
function collect(
  context: ServiceContext,
  kind: 'preapproval_plan' | 'preapproval' | 'authorized_payment',
  page: Paging,
  filters: { status?: string; externalReference?: string; lookup?: string },
  keep: (document: StoredDocument) => boolean,
): { total: number; results: readonly StoredDocument[] } {
  const found = context.store.documents.search(kind, {
    ...(filters.status === undefined ? {} : { status: filters.status }),
    ...(filters.externalReference === undefined ? {} : { externalReference: filters.externalReference }),
    ...(filters.lookup === undefined ? {} : { lookup: filters.lookup }),
    limit: PAGE_CAP,
    offset: 0,
    order: page.order,
  });
  const matched = found.results.filter(keep);
  return { total: matched.length, results: matched.slice(page.offset, page.offset + page.limit) };
}

const statusFilter = (params: URLSearchParams): string | undefined => {
  const status = params.get('status');
  return status === null || status === '' ? undefined : status;
};

export function searchPlans(context: ServiceContext, params: URLSearchParams): Result<Rendered, ErrorBody> {
  const page = paging(params);
  const query = params.get('q');
  const status = statusFilter(params);
  const found = collect(context, 'preapproval_plan', page, status === undefined ? {} : { status }, (document) =>
    query === null || readPlan(document).reason.toLowerCase().includes(query.toLowerCase()),
  );

  return ok({
    status: 200,
    body: {
      paging: { total: found.total, limit: page.limit, offset: page.offset },
      results: found.results.map((document) => renderPlan(context, document)),
    },
  });
}

/* ------------------------------------------------------------------ subscriptions */

interface CardDetails {
  paymentMethodId: string | null;
  cardId: number | null;
}

/** Card tokens are owned by another module; a subscription only mirrors what it can read. */
function cardDetails(context: ServiceContext, tokenId: string): CardDetails {
  const token = context.store.documents.get('card_token', tokenId);
  if (token === null) return { paymentMethodId: null, cardId: null };
  const method = token.doc['payment_method_id'];
  return { paymentMethodId: typeof method === 'string' ? method : null, cardId: token.sequence };
}

export function createSubscription(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));

  const planId = body['preapproval_plan_id'];
  if (planId !== undefined && typeof planId !== 'string') {
    return err(invalid('preapproval_plan_id must be a string'));
  }

  let plan: StoredDocument | null = null;
  if (typeof planId === 'string') {
    plan = context.store.documents.get('preapproval_plan', planId);
    if (plan === null) return err(invalid('preapproval_plan_id not found'));
    if (plan.status !== 'active') return err(invalid('preapproval_plan_id is not active'));
  }

  // A subscription created from a plan inherits its terms, so `auto_recurring` is optional there.
  const inherited = plan === null ? null : readPlan(plan);
  let recurrence: Recurrence;
  if (body['auto_recurring'] !== undefined) {
    const parsed = parseRecurrence(body['auto_recurring'], 'auto_recurring');
    if (!parsed.ok) return parsed;
    recurrence = parsed.value;
  } else if (inherited !== null) {
    recurrence = inherited.auto_recurring;
  } else {
    const validated = validateSubscriptionRequest(body);
    return err(validated.ok ? invalid('auto_recurring: required') : issues(validated.error));
  }

  const email = body['payer_email'];
  if (typeof email !== 'string' || !email.includes('@')) return err(invalid('payer_email invalid'));

  const rawReason = body['reason'];
  if (rawReason !== undefined && (typeof rawReason !== 'string' || rawReason.trim() === '')) {
    return err(invalid('reason must be a non-empty string'));
  }
  const reason = typeof rawReason === 'string' ? rawReason.trim() : (inherited?.reason ?? null);
  if (reason === null) return err(invalid('reason: required'));

  const rawNotificationUrl = body['notification_url'];
  if (rawNotificationUrl !== undefined && typeof rawNotificationUrl !== 'string') {
    return err(invalid('notification_url must be a string'));
  }
  // A subscription without one falls back to its plan, the way back_url does.
  const notificationUrl = rawNotificationUrl ?? (plan === null ? null : notificationUrlOf(plan));

  const token = body['card_token_id'];
  if (token !== undefined && typeof token !== 'string') return err(invalid('card_token_id must be a string'));

  const externalReference = body['external_reference'];
  if (externalReference !== undefined && typeof externalReference !== 'string') {
    return err(invalid('external_reference must be a string'));
  }

  const backUrl = body['back_url'];
  if (backUrl !== undefined && typeof backUrl !== 'string') return err(invalid('back_url must be a string'));

  const requested = body['status'];
  if (requested !== undefined && !STATUSES.includes(requested as SubscriptionStatus)) {
    return err(invalid('status is not one of the allowed values'));
  }
  if (requested === 'authorized' && typeof token !== 'string') {
    return err(invalid('status authorized requires card_token_id'));
  }

  // Without a card token the payer still has to authorize the subscription on the init_point.
  const authorized = typeof token === 'string' && requested !== 'pending';
  const now = context.clock.now();
  const card = typeof token === 'string' ? cardDetails(context, token) : { paymentMethodId: null, cardId: null };
  const plan_ = authorized ? schedule(recurrence, now) : { anchor: null, proportional: null };

  const document: StoredDocument = {
    kind: 'preapproval',
    id: resourceId(context.ids.uuid()),
    sequence: context.store.nextSequence('preapproval'),
    status: authorized ? 'authorized' : 'pending',
    externalReference: externalReference ?? null,
    lookup: email,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    doc: asJson({
      preapproval_plan_id: plan?.id ?? null,
      reason,
      payer_email: email,
      payer_id: payerIdFor(email),
      external_reference: externalReference ?? null,
      back_url: backUrl ?? inherited?.back_url ?? null,
      notification_url: notificationUrl ?? null,
      auto_recurring: recurrence,
      payment_method_id: authorized ? (card.paymentMethodId ?? BILLING_METHOD) : null,
      card_id: authorized ? card.cardId : null,
      anchor: plan_.anchor,
      cycle: 0,
      installments: 0,
      charged_amount: 0,
      proportional: plan_.proportional,
      retries: 0,
    }),
  };

  context.store.documents.insert(document);
  emit(
    context,
    'subscription_preapproval',
    authorized ? 'subscription.authorized' : 'created',
    document.id,
    notificationUrlOf(document),
  );
  return ok({ status: 201, body: renderSubscription(context, document) });
}

export function getSubscription(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const document = context.store.documents.get('preapproval', id);
  if (document === null) return err(notFound('Subscription not found'));
  return ok({ status: 200, body: renderSubscription(context, document) });
}

export function updateSubscription(
  context: ServiceContext,
  id: string,
  body: unknown,
): Result<Rendered, ErrorBody> {
  const document = context.store.documents.get('preapproval', id);
  if (document === null) return err(notFound('Subscription not found'));
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));

  const validated = validateSubscriptionUpdateRequest(body);
  if (!validated.ok) return err(issues(validated.error));

  const current = document.status as SubscriptionStatus;
  if (current === 'cancelled') {
    return err(unprocessable('operation not allowed', [{ code: 4051, description: 'subscription is cancelled' }]));
  }

  const doc = readSubscription(document);
  const now = context.clock.now();

  let recurrence = doc.auto_recurring;
  if (body['auto_recurring'] !== undefined) {
    const parsed = parseRecurrence(body['auto_recurring'], 'auto_recurring');
    if (!parsed.ok) return parsed;
    recurrence = parsed.value;
  }

  const token = validated.value.card_token_id;
  const card = token === undefined ? null : cardDetails(context, token);

  const requested = body['status'] === undefined ? current : (validated.value.status as SubscriptionStatus);
  const transition = allowed(current, requested);
  if (!transition) {
    return err(
      unprocessable('operation not allowed', [
        { code: 4051, description: `cannot move subscription from ${current} to ${requested}` },
      ]),
    );
  }
  if (requested === 'authorized' && current === 'pending' && token === undefined && doc.card_id === null && doc.payment_method_id === null) {
    return err(invalid('status authorized requires card_token_id'));
  }

  const next: SubscriptionDoc = {
    ...doc,
    auto_recurring: recurrence,
    reason: validated.value.reason?.trim() ?? doc.reason,
    external_reference: validated.value.external_reference ?? doc.external_reference,
    back_url: validated.value.back_url ?? doc.back_url,
    payment_method_id: card?.paymentMethodId ?? (token === undefined ? doc.payment_method_id : BILLING_METHOD),
    card_id: card?.cardId ?? doc.card_id,
  };

  if (current === 'pending' && requested === 'authorized') {
    const started = schedule(next.auto_recurring, now);
    next.anchor = started.anchor;
    next.proportional = started.proportional;
    next.cycle = 0;
  } else if (current === 'paused' && requested === 'authorized') {
    resume(next, now);
  }

  const updated: StoredDocument = {
    ...document,
    status: requested,
    externalReference: next.external_reference,
    updatedAt: now,
    doc: asJson(next),
  };

  context.store.documents.update(updated);
  emit(context, 'subscription_preapproval', action(current, requested), updated.id, notificationUrlOf(updated));
  return ok({ status: 200, body: renderSubscription(context, updated) });
}

/** Cancelling is terminal; every other move between the live statuses is allowed. */
function allowed(current: SubscriptionStatus, requested: SubscriptionStatus): boolean {
  if (current === requested) return true;
  if (current === 'cancelled') return false;
  if (requested === 'cancelled') return true;
  if (requested === 'pending') return false;
  return current !== 'pending' || requested === 'authorized';
}

/** A paused period is never billed retroactively, so missed cycles are skipped on resume. */
function resume(doc: SubscriptionDoc, now: number): void {
  if (doc.proportional !== null && !doc.proportional.charged && doc.proportional.at <= now) {
    doc.proportional = null;
  }
  let guard = 0;
  while (dueAt(doc, doc.cycle) <= now && guard++ < 10_000) doc.cycle++;
}

function action(current: SubscriptionStatus, requested: SubscriptionStatus): string {
  if (requested === 'cancelled') return 'subscription.cancelled';
  if (requested === 'authorized' && current !== 'authorized') return 'subscription.authorized';
  if (requested === 'paused') return 'subscription.paused';
  return 'updated';
}

/**
 * The export endpoint is the search endpoint rendered as a spreadsheet-friendly CSV, so it
 * reuses the same filtering rather than growing a second query path.
 * https://www.mercadopago.com.br/developers/en/reference/subscriptions/_preapproval_export/get
 */
const EXPORT_COLUMNS = [
  'id',
  'status',
  'reason',
  'external_reference',
  'payer_email',
  'preapproval_plan_id',
  'transaction_amount',
  'currency_id',
  'frequency',
  'frequency_type',
  'date_created',
  'last_modified',
  'next_payment_date',
] as const;

const csvCell = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function exportSubscriptions(
  context: ServiceContext,
  params: URLSearchParams,
): Result<{ status: number; fileName: string; body: string }, ErrorBody> {
  const collector = params.get('collector_id');
  if (collector === null || collector === '') {
    return err(badRequest('invalid parameters', [{ code: 2034, description: 'collector_id is required' }]));
  }
  if (collector !== String(context.collectorId)) {
    return err(notFound('collector not found'));
  }

  // The export covers everything the filters match, not one page of it.
  const scoped = new URLSearchParams(params);
  scoped.delete('collector_id');
  scoped.set('limit', '1000');
  scoped.set('offset', '0');

  const found = searchSubscriptions(context, scoped);
  if (!found.ok) return found;

  const body = found.value.body as { results?: JsonObject[] };
  const rows = body.results ?? [];
  const lines = [EXPORT_COLUMNS.join(',')];

  for (const row of rows) {
    const recurring = isJsonObject(row['auto_recurring']) ? row['auto_recurring'] : {};
    const payer = isJsonObject(row['payer']) ? row['payer'] : {};
    lines.push(
      [
        row['id'],
        row['status'],
        row['reason'],
        row['external_reference'],
        row['payer_email'] ?? payer['email'],
        row['preapproval_plan_id'],
        recurring['transaction_amount'],
        recurring['currency_id'],
        recurring['frequency'],
        recurring['frequency_type'],
        row['date_created'],
        row['last_modified'],
        row['next_payment_date'],
      ]
        .map(csvCell)
        .join(','),
    );
  }

  return ok({
    status: 200,
    fileName: `preapproval-${collector}.csv`,
    body: `${lines.join('\n')}\n`,
  });
}

export function searchSubscriptions(context: ServiceContext, params: URLSearchParams): Result<Rendered, ErrorBody> {
  const page = paging(params);
  const query = params.get('q');
  const planId = params.get('preapproval_plan_id');
  const payerId = params.get('payer_id');
  const amount = params.get('transaction_amount');
  const email = params.get('payer_email');

  const found = collect(
    context,
    'preapproval',
    page,
    {
      ...(statusFilter(params) === undefined ? {} : { status: statusFilter(params) as string }),
      ...(email === null ? {} : { lookup: email }),
      ...(params.get('external_reference') === null
        ? {}
        : { externalReference: params.get('external_reference') as string }),
    },
    (document) => {
      const doc = readSubscription(document);
      if (query !== null && !doc.reason.toLowerCase().includes(query.toLowerCase())) return false;
      if (planId !== null && doc.preapproval_plan_id !== planId) return false;
      if (payerId !== null && doc.payer_id !== Number(payerId)) return false;
      if (amount !== null && doc.auto_recurring.transaction_amount !== Number(amount)) return false;
      return true;
    },
  );

  return ok({
    status: 200,
    body: {
      paging: { total: found.total, limit: page.limit, offset: page.offset },
      results: found.results.map((document) => renderSubscription(context, document)),
    },
  });
}

/* ------------------------------------------------------------------ invoices */

export function getAuthorizedPayment(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const document = context.store.documents.get('authorized_payment', id);
  if (document === null) return err(notFound('Authorized payment not found'));
  return ok({ status: 200, body: renderAuthorized(document) });
}

export function searchAuthorizedPayments(
  context: ServiceContext,
  params: URLSearchParams,
): Result<Rendered, ErrorBody> {
  const page = paging(params);
  const preapprovalId = params.get('preapproval_id');
  const paymentId = params.get('payment_id');
  const payerId = params.get('payer_id');

  const found = collect(
    context,
    'authorized_payment',
    page,
    {
      ...(statusFilter(params) === undefined ? {} : { status: statusFilter(params) as string }),
      ...(preapprovalId === null ? {} : { lookup: preapprovalId }),
    },
    (document) => {
      const doc = readAuthorized(document);
      if (paymentId !== null && doc.payment_id !== Number(paymentId)) return false;
      if (payerId === null) return true;
      const subscription = context.store.documents.get('preapproval', doc.preapproval_id);
      return subscription !== null && readSubscription(subscription).payer_id === Number(payerId);
    },
  );

  return ok({
    status: 200,
    body: {
      paging: { total: found.total, limit: page.limit, offset: page.offset },
      results: found.results.map(renderAuthorized),
    },
  });
}

/* ------------------------------------------------------------------ billing */

interface Charge {
  approved: boolean;
  paymentId: number | null;
  status: string | null;
  detail: string | null;
}

function chargeOnce(context: ServiceContext, document: StoredDocument, doc: SubscriptionDoc, amount: Minor, cycle: number): Charge {
  const created = createPayment(context, {
    transaction_amount: toDecimal(amount),
    payment_method_id: BILLING_METHOD,
    description: doc.reason,
    payer: { email: doc.payer_email },
    ...(doc.external_reference === null ? {} : { external_reference: doc.external_reference }),
    // The generated payment notifies the subscription's url, so one target sees the whole cycle.
    ...(doc.notification_url === null ? {} : { notification_url: doc.notification_url }),
    metadata: { preapproval_id: document.id, cycle },
  });

  if (!created.ok) {
    return { approved: false, paymentId: null, status: null, detail: created.error.message };
  }

  const payload = isJsonObject(created.value.body) ? created.value.body : null;
  const paymentId = typeof payload?.['id'] === 'number' ? payload['id'] : null;
  const status = typeof payload?.['status'] === 'string' ? payload['status'] : null;
  const detail = typeof payload?.['status_detail'] === 'string' ? payload['status_detail'] : null;
  return { approved: status === 'approved', paymentId, status, detail };
}

/** Reuses the invoice left behind by a failed attempt so a retry recycles it, as MP does. */
function recordInvoice(
  context: ServiceContext,
  subscription: StoredDocument,
  cycle: number,
  amount: Minor,
  charge: Charge,
): StoredDocument {
  const now = context.clock.now();
  const url = notificationUrlOf(subscription);
  const status = charge.approved ? 'processed' : 'recycling';
  const existing = context.store.documents
    .search('authorized_payment', { lookup: subscription.id, status: 'recycling', limit: PAGE_CAP, offset: 0 })
    .results.find((document) => readAuthorized(document).cycle === cycle);

  const doc: AuthorizedPaymentDoc = {
    preapproval_id: subscription.id,
    cycle,
    transaction_amount: toDecimal(amount),
    payment_id: charge.paymentId,
    payment_status: charge.status,
    payment_status_detail: charge.detail,
    status_detail: charge.approved ? 'approved' : (charge.detail ?? 'rejected'),
    retries: existing === undefined ? 0 : readAuthorized(existing).retries + 1,
  };

  if (existing !== undefined) {
    const updated: StoredDocument = { ...existing, status, updatedAt: now, doc: asJson(doc) };
    context.store.documents.update(updated);
    emit(context, 'subscription_authorized_payment', 'updated', String(updated.sequence), url);
    return updated;
  }

  // The resource id is the sequence: MP exposes an integer invoice id.
  const sequence = AUTHORIZED_PAYMENT_BASE + context.store.nextSequence('authorized_payment');
  const created: StoredDocument = {
    kind: 'authorized_payment',
    id: String(sequence),
    sequence,
    status,
    externalReference: null,
    lookup: subscription.id,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    doc: asJson(doc),
  };
  context.store.documents.insert(created);
  emit(context, 'subscription_authorized_payment', 'created', String(created.sequence), url);
  return created;
}

/**
 * Advances every authorized subscription whose next charge is due at `at`. A failed charge
 * leaves the cycle in place so the next run retries it instead of dropping the subscription.
 */
export function runBilling(context: ServiceContext, at: number): { charged: number; failed: number } {
  const subscriptions = context.store.documents.search('preapproval', {
    status: 'authorized',
    limit: PAGE_CAP,
    offset: 0,
    order: 'asc',
  });

  let charged = 0;
  let failed = 0;

  for (const subscription of subscriptions.results) {
    const doc = readSubscription(subscription);
    if (doc.anchor === null) continue;
    let touched = false;

    for (let round = 0; round < CYCLES_PER_RUN; round++) {
      const pending = doc.proportional;
      const proportional = pending !== null && !pending.charged && pending.at <= at;
      if (!proportional && (exhausted(doc) || dueAt(doc, doc.cycle) > at)) break;

      const cycle = proportional ? -1 : doc.cycle;
      const amount = (proportional ? (pending as Proportional).amount : amountOf(doc.auto_recurring)) as Minor;
      const result = chargeOnce(context, subscription, doc, amount, cycle);
      recordInvoice(context, subscription, cycle, amount, result);
      touched = true;

      if (!result.approved) {
        doc.retries += 1;
        failed += 1;
        break;
      }

      doc.charged_amount += amount;
      if (proportional) doc.proportional = { ...(pending as Proportional), charged: true };
      else {
        doc.cycle += 1;
        doc.installments += 1;
      }
      doc.retries = 0;
      charged += 1;
    }

    if (touched) {
      context.store.documents.update({ ...subscription, updatedAt: context.clock.now(), doc: asJson(doc) });
      emit(context, 'subscription_preapproval', 'updated', subscription.id, notificationUrlOf(subscription));
    }
  }

  return { charged, failed };
}
