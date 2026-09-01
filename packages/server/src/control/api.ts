import {
  type FaultProfile,
  type Payment,
  type PaymentCommand,
  type Sandbox,
  type SandboxStore,
  type WebhookDelivery,
  type WebhookDeliveryId,
  apply,
  fromDecimal,
  isJsonObject,
  sandboxId,
  toDecimal,
  webhookDeliveryId,
} from '@payground/core';
import { providerStatus } from '@payground/mercadopago/mapping/status.ts';
import type { Storage } from '@payground/storage';

export interface ControlResult {
  status: number;
  body: unknown;
}

const fail = (status: number, message: string): ControlResult => ({ status, body: { error: message } });

const publicSandbox = (sandbox: Sandbox) => ({
  id: sandbox.id,
  name: sandbox.name,
  accessToken: sandbox.accessToken,
  publicKey: sandbox.publicKey,
  webhookSecret: sandbox.webhookSecret,
  liveMode: sandbox.liveMode,
  createdAt: sandbox.createdAt,
});

export function paymentView(payment: Payment, store: SandboxStore) {
  const provider = providerStatus(payment);
  return {
    id: payment.id,
    sequence: store.payments.sequenceOf(payment.id) ?? 0,
    state: payment.status.state,
    reason: payment.status.reason,
    providerStatus: provider.status,
    providerStatusDetail: provider.status_detail,
    methodKind: payment.method.kind,
    methodCode: payment.method.code,
    amount: payment.amount,
    capturedAmount: payment.capturedAmount,
    refundedAmount: payment.refundedAmount,
    currency: payment.currency,
    payerEmail: payment.payer.email,
    description: payment.description,
    externalReference: payment.externalReference,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
    expiresAt: payment.expiresAt,
  };
}

const deliveryView = (delivery: WebhookDelivery, store: SandboxStore) => ({
  id: delivery.id,
  paymentId: delivery.resourceType === 'payment' ? delivery.resourceId : null,
  event: delivery.event,
  url: delivery.url,
  status: delivery.status,
  attempts: delivery.attempts,
  lastStatusCode: delivery.lastStatusCode,
  lastError: delivery.lastError,
  requestHeaders: delivery.requestHeaders,
  requestBody: delivery.requestBody,
  responseBody: delivery.responseBody,
  nextAttemptAt: delivery.nextAttemptAt,
  createdAt: delivery.createdAt,
  history: store.webhooks.attempts(delivery.id),
});

export interface ControlDeps {
  storage: Storage;
  now: () => number;
  uuid: () => string;
  /** Queues the notification a state change would produce on the real API. */
  notify: (sandbox: Sandbox, action: string, dataId: string, notificationUrl: string | null) => void;
}

export function listSandboxes(deps: ControlDeps): ControlResult {
  return { status: 200, body: deps.storage.sandboxes.list().map(publicSandbox) };
}

export function createSandbox(deps: ControlDeps, body: unknown): ControlResult {
  const name = isJsonObject(body) && typeof body['name'] === 'string' ? body['name'] : 'sandbox';
  const sandbox: Sandbox = {
    id: sandboxId(deps.uuid()),
    name,
    accessToken: `TEST-${deps.uuid()}`,
    publicKey: `TEST-${deps.uuid()}`,
    webhookSecret: deps.uuid(),
    liveMode: false,
    createdAt: deps.now(),
  };
  deps.storage.sandboxes.create(sandbox);
  return { status: 201, body: publicSandbox(sandbox) };
}

function resolve(deps: ControlDeps, id: string): { sandbox: Sandbox; store: SandboxStore } | null {
  const sandbox = deps.storage.sandboxes.get(sandboxId(id));
  if (sandbox === null) return null;
  return { sandbox, store: deps.storage.forSandbox(sandbox.id) };
}

export function getSandbox(deps: ControlDeps, id: string): ControlResult {
  const found = resolve(deps, id);
  if (found === null) return fail(404, 'sandbox not found');
  const payments = found.store.payments.search({ limit: 1 });
  return {
    status: 200,
    body: {
      ...publicSandbox(found.sandbox),
      counts: {
        payments: payments.total,
        webhooks: found.store.webhooks.list(1000).length,
      },
    },
  };
}

export function resetSandbox(deps: ControlDeps, id: string): ControlResult {
  if (resolve(deps, id) === null) return fail(404, 'sandbox not found');
  deps.storage.sandboxes.reset(sandboxId(id));
  return { status: 200, body: { ok: true } };
}

export function deleteSandbox(deps: ControlDeps, id: string): ControlResult {
  if (resolve(deps, id) === null) return fail(404, 'sandbox not found');
  deps.storage.sandboxes.remove(sandboxId(id));
  return { status: 200, body: { ok: true } };
}

export function listPayments(deps: ControlDeps, id: string, params: URLSearchParams): ControlResult {
  const found = resolve(deps, id);
  if (found === null) return fail(404, 'sandbox not found');

  const page = found.store.payments.search({
    ...(params.has('state') ? { states: [params.get('state') as never] } : {}),
    ...(params.has('method') ? { methodCode: params.get('method') as string } : {}),
    ...(params.has('external_reference') ? { externalReference: params.get('external_reference') as string } : {}),
    ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
    ...(params.has('offset') ? { offset: Number(params.get('offset')) } : {}),
  });

  return {
    status: 200,
    body: {
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      results: page.results.map((payment) => paymentView(payment, found.store)),
    },
  };
}

export function getPaymentDetail(deps: ControlDeps, id: string, paymentId: string): ControlResult {
  const found = resolve(deps, id);
  if (found === null) return fail(404, 'sandbox not found');

  const payment = found.store.payments.get(paymentId as never);
  if (payment === null) return fail(404, 'payment not found');

  return {
    status: 200,
    body: {
      payment: paymentView(payment, found.store),
      timeline: found.store.payments.timeline(payment.id).map((entry) => ({
        at: entry.at,
        command: entry.command,
        from: entry.from,
        to: entry.to,
      })),
      refunds: found.store.refunds.listFor(payment.id).map((refund) => ({
        id: refund.id,
        sequence: found.store.refunds.sequenceOf(refund.id) ?? 0,
        amount: refund.amount,
        status: refund.status,
        partial: refund.partial,
        createdAt: refund.createdAt,
      })),
    },
  };
}

function toCommand(body: unknown): PaymentCommand | null {
  if (!isJsonObject(body)) return null;
  const type = body['type'];
  switch (type) {
    case 'settle':
    case 'expire':
    case 'dispute':
      return { type };
    case 'decline':
      return { type, reason: (body['reason'] as PaymentCommand extends { reason: infer R } ? R : never) ?? 'other' };
    case 'cancel':
      return { type, by: body['by'] === 'payer' ? 'payer' : 'collector' };
    case 'resolve':
      return { type, outcome: body['outcome'] === 'merchant' ? 'merchant' : 'chargeback' };
    case 'review':
      return { type, reason: 'manual_review' };
    case 'capture': {
      const amount = body['amount'];
      if (amount === null || amount === undefined) return { type, amount: null };
      if (typeof amount !== 'number') return null;
      const parsed = fromDecimal(toDecimal(amount as never));
      return parsed.ok ? { type, amount: parsed.value } : null;
    }
    case 'refund': {
      const amount = body['amount'];
      if (typeof amount !== 'number') return null;
      const parsed = fromDecimal(toDecimal(amount as never));
      return parsed.ok ? { type, amount: parsed.value } : null;
    }
    default:
      return null;
  }
}

export function actOnPayment(
  deps: ControlDeps,
  id: string,
  paymentId: string,
  body: unknown,
): ControlResult {
  const found = resolve(deps, id);
  if (found === null) return fail(404, 'sandbox not found');

  const payment = found.store.payments.get(paymentId as never);
  if (payment === null) return fail(404, 'payment not found');

  const command = toCommand(body);
  if (command === null) return fail(400, 'unknown action');

  const result = apply(payment, command, deps.now());
  if (!result.ok) return { status: 409, body: { error: 'invalid transition', detail: result.error } };

  found.store.payments.update(result.value.payment);
  found.store.payments.record(result.value);
  deps.notify(
    found.sandbox,
    'payment.updated',
    String(found.store.payments.sequenceOf(payment.id) ?? 0),
    result.value.payment.notificationUrl,
  );

  return { status: 200, body: { payment: paymentView(result.value.payment, found.store) } };
}

export function listWebhooks(deps: ControlDeps, id: string): ControlResult {
  const found = resolve(deps, id);
  if (found === null) return fail(404, 'sandbox not found');
  return { status: 200, body: found.store.webhooks.list().map((d) => deliveryView(d, found.store)) };
}

export function replayWebhook(deps: ControlDeps, id: string, deliveryId: string): ControlResult {
  const found = resolve(deps, id);
  if (found === null) return fail(404, 'sandbox not found');

  const delivery = found.store.webhooks.get(webhookDeliveryId(deliveryId) as WebhookDeliveryId);
  if (delivery === null) return fail(404, 'delivery not found');

  found.store.webhooks.update({
    ...delivery,
    status: 'queued',
    nextAttemptAt: deps.now(),
    updatedAt: deps.now(),
  });
  return { status: 200, body: { ok: true } };
}

export function getFaults(deps: ControlDeps, id: string): ControlResult {
  const found = resolve(deps, id);
  if (found === null) return fail(404, 'sandbox not found');
  return { status: 200, body: found.store.faults.get() };
}

export function setFaults(deps: ControlDeps, id: string, body: unknown): ControlResult {
  const found = resolve(deps, id);
  if (found === null) return fail(404, 'sandbox not found');
  if (!isJsonObject(body)) return fail(400, 'invalid body');

  const current = found.store.faults.get();
  const number = (key: string, fallback: number): number =>
    typeof body[key] === 'number' && Number.isFinite(body[key]) ? (body[key] as number) : fallback;
  const flag = (key: string, fallback: boolean): boolean =>
    typeof body[key] === 'boolean' ? (body[key] as boolean) : fallback;

  const profile: FaultProfile = {
    latencyMs: Math.max(0, number('latencyMs', current.latencyMs)),
    errorRate: Math.min(Math.max(number('errorRate', current.errorRate), 0), 1),
    unavailable: flag('unavailable', current.unavailable),
    duplicateWebhooks: flag('duplicateWebhooks', current.duplicateWebhooks),
    webhookFailureRate: Math.min(Math.max(number('webhookFailureRate', current.webhookFailureRate), 0), 1),
  };
  found.store.faults.set(profile);
  return { status: 200, body: profile };
}
