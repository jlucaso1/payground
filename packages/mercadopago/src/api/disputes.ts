import {
  type JsonObject,
  type Payment,
  type Result,
  type StoredDocument,
  apply,
  err,
  isJsonObject,
  ok,
  toDecimal,
} from '@payground/core';
import { type ErrorBody, badRequest, notFound, unprocessable } from '../errors.ts';
import { formatDateTime } from '../serialize/datetime.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { listRefunds, materialize, updatePayment } from './payments.ts';
import { commit } from './transition.ts';

/** The collector has seven days to send documentation before the dispute is lost. */
export const DOCUMENTATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function locate(context: ServiceContext, id: string): { payment: Payment; sequence: number } | null {
  const sequence = Number(id);
  if (!Number.isInteger(sequence)) return null;
  const found = context.store.payments.bySequence(sequence);
  return found === null ? null : { payment: materialize(context, found), sequence };
}

const disputedAt = (context: ServiceContext, payment: Payment): number | null =>
  context.store.payments.timeline(payment.id).findLast((entry) => entry.command.type === 'dispute')?.at ??
  null;

function open(
  context: ServiceContext,
  payment: Payment,
  sequence: number,
  at: number,
  existing: StoredDocument | null,
): StoredDocument {
  const deadline = at + DOCUMENTATION_WINDOW_MS;
  const document: StoredDocument = {
    kind: 'chargeback',
    id: String(sequence),
    sequence,
    status: 'pending',
    externalReference: payment.externalReference,
    lookup: payment.id,
    // `documents.update` never rewrites created_at, so the row keeps the first dispute.
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
    expiresAt: deadline,
    doc: {
      id: String(sequence),
      payment_id: sequence,
      payments: [sequence],
      currency: payment.currency,
      amount: toDecimal(payment.capturedAmount),
      live_mode: context.sandbox.liveMode,
      status: 'pending',
      coverage_applied: false,
      // Only card sales are eligible for the seller protection programme.
      coverage_elegible: payment.method.kind === 'card',
      documentation_required: true,
      documentation_status: 'not_supplied',
      documentation: [],
      date_documentation_deadline: formatDateTime(deadline),
      date_created: formatDateTime(at),
      date_last_updated: formatDateTime(at),
    },
  };
  if (existing === null) context.store.documents.insert(document);
  else context.store.documents.update(document);
  return document;
}

function closed(document: StoredDocument, outcome: 'won' | 'lost', now: number): StoredDocument {
  return {
    ...document,
    status: outcome,
    updatedAt: now,
    expiresAt: null,
    doc: {
      ...document.doc,
      status: outcome,
      documentation_required: false,
      coverage_applied: outcome === 'lost' && document.doc['coverage_elegible'] === true,
      date_last_updated: formatDateTime(now),
    },
  };
}

function persist(context: ServiceContext, document: StoredDocument): StoredDocument {
  context.store.documents.update(document);
  return document;
}

/**
 * The dispute lives on the payment, so the chargeback is only ever a view of it: an
 * outcome reached through the control API or by the deadline is picked up on read.
 */
function sync(context: ServiceContext, document: StoredDocument, payment: Payment): StoredDocument {
  if (document.status !== 'pending') return document;
  const now = context.clock.now();

  if (payment.status.state === 'charged_back') return persist(context, closed(document, 'lost', now));
  if (payment.status.state !== 'in_mediation') return persist(context, closed(document, 'won', now));

  const deadline = document.expiresAt;
  if (deadline === null || now < deadline) return document;

  const resolved = apply(payment, { type: 'resolve', outcome: 'chargeback' }, now);
  if (!resolved.ok) return document;
  commit(context, resolved.value);
  return persist(context, closed(document, 'lost', now));
}

interface Located {
  document: StoredDocument;
  payment: Payment;
}

function find(context: ServiceContext, id: string): Result<Located, ErrorBody> {
  const located = locate(context, id);
  if (located === null) return err(notFound('Chargeback not found'));
  const { payment, sequence } = located;

  const existing = context.store.documents.get('chargeback', String(sequence));
  const at = disputedAt(context, payment);

  // A payment can be disputed again after winning one, which reopens the same resource.
  if (existing !== null && (at === null || at <= existing.updatedAt)) {
    return ok({ document: sync(context, existing, payment), payment });
  }
  if (at === null) return err(notFound('Chargeback not found'));

  const opened = open(context, payment, sequence, at, existing);
  return ok({ document: sync(context, opened, payment), payment });
}

export function getChargeback(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const found = find(context, id);
  if (!found.ok) return found;
  return ok({ status: 200, body: found.value.document.doc });
}

function parseFiles(body: unknown): Result<JsonObject[], ErrorBody> {
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));
  const files = body['files'];
  if (!Array.isArray(files) || files.length === 0) {
    return err(badRequest('invalid parameters', [{ code: 2034, description: 'files is required' }]));
  }

  const documentation: JsonObject[] = [];
  for (const file of files) {
    if (!isJsonObject(file) || typeof file['url'] !== 'string') {
      return err(badRequest('invalid parameters', [{ code: 2034, description: 'files[].url is required' }]));
    }
    documentation.push({
      name: typeof file['name'] === 'string' ? file['name'] : '',
      description: typeof file['description'] === 'string' ? file['description'] : '',
      url: file['url'],
    });
  }
  return ok(documentation);
}

/** Sending documentation settles the dispute in the collector's favour. */
export function updateChargeback(
  context: ServiceContext,
  id: string,
  body: unknown,
): Result<Rendered, ErrorBody> {
  const found = find(context, id);
  if (!found.ok) return found;
  const { document, payment } = found.value;

  if (document.status !== 'pending') {
    return err(
      unprocessable('operation not allowed', [
        { code: 4051, description: `chargeback already ${document.status}` },
      ]),
    );
  }

  const files = parseFiles(body);
  if (!files.ok) return files;

  const now = context.clock.now();
  const resolved = apply(payment, { type: 'resolve', outcome: 'merchant' }, now);
  if (!resolved.ok) {
    return err(unprocessable('operation not allowed', [{ code: 4051, description: resolved.error.kind }]));
  }
  commit(context, resolved.value);

  const won = closed(document, 'won', now);
  const updated = persist(context, {
    ...won,
    doc: { ...won.doc, documentation: files.value, documentation_status: 'valid' },
  });

  return ok({ status: 200, body: updated.doc });
}

export function getRefund(
  context: ServiceContext,
  id: string,
  refundId: string,
): Result<Rendered, ErrorBody> {
  const listed = listRefunds(context, id);
  if (!listed.ok) return listed;

  const wanted = Number(refundId);
  const refunds = Array.isArray(listed.value.body) ? listed.value.body : [];
  const found = refunds.filter(isJsonObject).find((refund) => refund['id'] === wanted);
  if (found === undefined) return err(notFound('Refund not found'));
  return ok({ status: 200, body: found });
}

/** The legacy cancellation endpoint is `PUT /v1/payments/{id}` with a cancelled status. */
export function cancelPayment(
  context: ServiceContext,
  id: string,
  body: unknown,
): Result<Rendered, ErrorBody> {
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));
  if (body['status'] !== 'cancelled') {
    return err(badRequest('invalid parameters', [{ code: 2001, description: 'status must be cancelled' }]));
  }
  return updatePayment(context, id, { status: 'cancelled' });
}
