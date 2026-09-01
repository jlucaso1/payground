import {
  type JsonObject,
  type JsonValue,
  type Payment,
  type Result,
  type StoredDocument,
  type Transition,
  apply,
  err,
  isJsonObject,
  ok,
  refundable,
  toDecimal,
} from '@payground/core';
import { type ErrorBody, badRequest, notFound, unprocessable } from '../errors.ts';
import type {
  Claim,
  ClaimEvidence,
  ClaimHistoryEntry,
  ClaimMessage,
  ClaimReason,
  MediationResolution,
} from '../generated/types.ts';
import { validateSendMessageRequest } from '../generated/validate.ts';
import { formatDateTime } from '../serialize/datetime.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { readArray, readNumber, readObjects, readString } from './document.ts';
import { createRefund } from './payments.ts';

export type ClaimState = 'opened' | 'dispute' | 'closed' | 'cancelled';
export type ClaimCommand = 'escalate' | 'resolve' | 'close' | 'cancel';

/** The whole claim state machine, as data. Nothing transitions unless it is listed here. */
export const CLAIM_TRANSITIONS = {
  opened: ['escalate', 'close', 'cancel'],
  dispute: ['resolve'],
  closed: [],
  cancelled: [],
} as const satisfies Record<ClaimState, readonly ClaimCommand[]>;

const NEXT: Record<ClaimCommand, ClaimState> = {
  escalate: 'dispute',
  resolve: 'closed',
  close: 'closed',
  cancel: 'cancelled',
};

/**
 * The wire has two fields where the machine has one: `stage` says how far the claim went,
 * `status` says whether it is still open.
 * https://www.mercadopago.com.br/developers/en/docs/post-purchase/claims/introduction
 */
const WIRE: Record<ClaimState, { status: NonNullable<Claim['status']>; stage: NonNullable<Claim['stage']> }> = {
  opened: { status: 'opened', stage: 'claim' },
  dispute: { status: 'opened', stage: 'dispute' },
  closed: { status: 'closed', stage: 'resolution' },
  cancelled: { status: 'cancelled', stage: 'claim' },
};

const ACTIONS: Record<ClaimState, { complainant: string[]; respondent: string[] }> = {
  opened: {
    complainant: ['send_message', 'open_dispute', 'cancel_claim'],
    respondent: ['send_message', 'send_evidence'],
  },
  dispute: { complainant: ['send_message'], respondent: ['send_message', 'send_evidence'] },
  closed: { complainant: [], respondent: [] },
  cancelled: { complainant: [], respondent: [] },
};

export const claimAllowed = (state: ClaimState, command: ClaimCommand): boolean =>
  (CLAIM_TRANSITIONS[state] as readonly ClaimCommand[]).includes(command);

export type ClaimError = { kind: 'invalid_transition'; from: ClaimState; command: ClaimCommand };

export type ChangedBy = NonNullable<ClaimHistoryEntry['changed_by']>;
export type SenderRole = NonNullable<ClaimMessage['sender_role']>;
export type EvidenceType = NonNullable<ClaimEvidence['type']>;

export interface ClaimFile {
  readonly id: string;
  readonly createdAt: number;
  readonly type: EvidenceType;
  readonly description: string | null;
  /** Null when the evidence is a bare `value` rather than an uploaded file. */
  readonly fileName: string | null;
  readonly contentType: string | null;
  readonly size: number | null;
  /** Base64; the store holds JSON only, so bytes cannot be kept raw. */
  readonly data: string | null;
  readonly value: string | null;
}

export interface ClaimResolution {
  readonly type: 'refund' | 'return' | 'partial_refund' | 'seller_favour';
  readonly reason: string | null;
  readonly at: number;
  readonly benefited: readonly SenderRole[];
}

export interface ClaimRecord {
  readonly id: number;
  readonly state: ClaimState;
  readonly type: NonNullable<Claim['type']>;
  readonly paymentId: number;
  readonly buyerId: number;
  readonly reasonId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly history: readonly ClaimHistoryEntry[];
  readonly attachments: readonly ClaimFile[];
  readonly evidences: readonly ClaimFile[];
  readonly resolution: ClaimResolution | null;
}

const CLAIM_BASE = 5_000_000_000;
const MESSAGE_BASE = 6_000_000_000;
const BUYER_BASE = 200_000_000;

/** The documented per-file limit: "JPEG, PNG, or PDF, max 10 MB" (spec3.json attachClaimFile). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** payground's own bound: the bytes live inline on the claim document, so the count is capped. */
const MAX_ATTACHMENTS = 5;
const MAX_MESSAGE_LENGTH = 2_000;

/**
 * Reason codes are a fixed per-site catalogue and there is no endpoint that lists them —
 * only GET /post-purchase/v1/claims/reasons/{reason_id} resolves one. payground commits
 * the codes the Brazilian post-purchase flow issues, in the published `AAA0000` shape.
 * https://www.mercadopago.com.br/developers/en/reference/claims/get-claim-reason/get
 */
export const CLAIM_REASONS: readonly ClaimReason[] = [
  {
    id: 'PNR0001',
    description: 'The buyer did not receive the product',
    detail: 'Product not received within the agreed delivery window',
    type: 'claims',
    group: 'shipping',
    flow: 'not_delivered',
  },
  {
    id: 'PDD0001',
    description: 'The product is different from the description',
    detail: 'Received item does not match the published description',
    type: 'claims',
    group: 'product',
    flow: 'different_product',
  },
  {
    id: 'PDD0002',
    description: 'The product arrived damaged or defective',
    detail: 'Received item is broken, incomplete or does not work',
    type: 'claims',
    group: 'product',
    flow: 'defective_product',
  },
  {
    id: 'PDA0001',
    description: 'The delivery is delayed',
    detail: 'Shipment is past its estimated delivery date',
    type: 'claims',
    group: 'shipping',
    flow: 'delayed',
  },
  {
    id: 'SNR0001',
    description: 'The service was not provided',
    detail: 'Paid service was never rendered',
    type: 'claims',
    group: 'service',
    flow: 'not_provided',
  },
  {
    id: 'CHG0001',
    description: 'The buyer does not recognise the charge',
    detail: 'Charge disputed by the account holder',
    type: 'mediations',
    group: 'payment',
    flow: 'unrecognized',
  },
  {
    id: 'RTN0001',
    description: 'The buyer wants to return the product',
    detail: 'Return requested within the buyer protection window',
    type: 'claims',
    group: 'product',
    flow: 'return',
  },
];

const reasonById = (id: string): ClaimReason | null =>
  CLAIM_REASONS.find((reason) => reason.id === id) ?? null;

const historyEntry = (state: ClaimState, at: number, by: ChangedBy): ClaimHistoryEntry => ({
  date: formatDateTime(at),
  status: WIRE[state].status,
  stage: WIRE[state].stage,
  changed_by: by,
});

export function applyClaim(
  record: ClaimRecord,
  command: ClaimCommand,
  now: number,
  by: ChangedBy,
): Result<ClaimRecord, ClaimError> {
  if (!claimAllowed(record.state, command)) {
    return err({ kind: 'invalid_transition', from: record.state, command });
  }
  const state = NEXT[command];
  return ok({
    ...record,
    state,
    updatedAt: now,
    history: [...record.history, historyEntry(state, now, by)],
  });
}

const SAFE_MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}$/;

/**
 * Everything outside the safe set becomes `_`, so a name can neither traverse a path nor
 * terminate a `content-disposition` header with a quote or a newline.
 */
export function sanitizeFileName(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  if (cleaned === '' || /^\.+$/.test(cleaned)) return null;
  return cleaned;
}

export const sanitizeMediaType = (raw: string): string => {
  const value = raw.split(';')[0]?.trim() ?? '';
  return SAFE_MEDIA_TYPE.test(value) ? value.toLowerCase() : 'application/octet-stream';
};

export interface UploadedFile {
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

const toFile = (
  context: ServiceContext,
  upload: UploadedFile,
  type: EvidenceType,
  description: string | null,
): Result<ClaimFile, ErrorBody> => {
  const fileName = sanitizeFileName(upload.fileName);
  if (fileName === null) return err(badRequest('invalid file name', [{ code: 4002, description: 'file_name' }]));
  if (upload.bytes.byteLength === 0) return err(badRequest('the file is empty', [{ code: 4003, description: 'file' }]));
  if (upload.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return err(
      badRequest('the file exceeds the maximum size', [
        { code: 4004, description: `max ${MAX_ATTACHMENT_BYTES} bytes` },
      ]),
    );
  }
  return ok({
    id: context.ids.uuid(),
    fileName,
    contentType: sanitizeMediaType(upload.contentType),
    size: upload.bytes.byteLength,
    createdAt: context.clock.now(),
    data: Buffer.from(upload.bytes).toString('base64'),
    type,
    description,
    value: null,
  });
};

const fileToJson = (file: ClaimFile): JsonObject => ({
  id: file.id,
  file_name: file.fileName,
  content_type: file.contentType,
  size: file.size,
  created_at: file.createdAt,
  data: file.data,
  type: file.type,
  description: file.description,
  value: file.value,
});

const EVIDENCE_TYPES: readonly EvidenceType[] = [
  'tracking_code',
  'proof_of_delivery',
  'photo',
  'invoice',
  'other',
];

export const evidenceType = (raw: string | null): EvidenceType =>
  EVIDENCE_TYPES.find((type) => type === raw) ?? 'other';

const readFile = (doc: JsonObject): ClaimFile => ({
  id: readString(doc, 'id') ?? '',
  fileName: readString(doc, 'file_name'),
  contentType: readString(doc, 'content_type'),
  size: readNumber(doc, 'size'),
  createdAt: readNumber(doc, 'created_at') ?? 0,
  data: readString(doc, 'data'),
  type: evidenceType(readString(doc, 'type')),
  description: readString(doc, 'description'),
  value: readString(doc, 'value'),
});

const STATES: readonly ClaimState[] = ['opened', 'dispute', 'closed', 'cancelled'];

const readState = (raw: string | null): ClaimState => STATES.find((state) => state === raw) ?? 'opened';

const readHistory = (doc: JsonObject): ClaimHistoryEntry[] =>
  readObjects(doc, 'history').map((entry) => entry as ClaimHistoryEntry);

function readResolution(doc: JsonObject): ClaimResolution | null {
  const value = doc['resolution'];
  if (!isJsonObject(value)) return null;
  const type = readString(value, 'type');
  return {
    type:
      type === 'return' || type === 'partial_refund' || type === 'seller_favour' || type === 'refund'
        ? type
        : 'refund',
    reason: readString(value, 'reason'),
    at: readNumber(value, 'at') ?? 0,
    benefited: readArray(value, 'benefited').filter((role): role is SenderRole => role === 'complainant' || role === 'respondent'),
  };
}

/**
 * `files: false` skips the base64 payloads, which nothing outside the file endpoints reads;
 * a search over a sandbox full of attachments would otherwise copy every blob.
 */
export function readClaim(document: StoredDocument, files = true): ClaimRecord {
  const doc = document.doc;
  return {
    id: readNumber(doc, 'id') ?? 0,
    state: readState(readString(doc, 'state')),
    type: readString(doc, 'type') === 'mediations' ? 'mediations' : 'claims',
    paymentId: readNumber(doc, 'payment_id') ?? 0,
    buyerId: readNumber(doc, 'buyer_id') ?? 0,
    reasonId: readString(doc, 'reason_id') ?? '',
    createdAt: readNumber(doc, 'created_at') ?? document.createdAt,
    updatedAt: readNumber(doc, 'updated_at') ?? document.updatedAt,
    history: readHistory(doc),
    attachments: files ? readObjects(doc, 'attachments').map(readFile) : [],
    evidences: files ? readObjects(doc, 'evidences').map(readFile) : [],
    resolution: readResolution(doc),
  };
}

const toDocument = (record: ClaimRecord): StoredDocument => ({
  kind: 'claim',
  id: String(record.id),
  sequence: record.id,
  status: record.state,
  externalReference: null,
  lookup: String(record.paymentId),
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  expiresAt: null,
  doc: {
    id: record.id,
    state: record.state,
    type: record.type,
    payment_id: record.paymentId,
    buyer_id: record.buyerId,
    reason_id: record.reasonId,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    history: record.history as unknown as JsonValue[],
    attachments: record.attachments.map(fileToJson),
    evidences: record.evidences.map(fileToJson),
    resolution:
      record.resolution === null
        ? null
        : {
            type: record.resolution.type,
            reason: record.resolution.reason,
            at: record.resolution.at,
            benefited: [...record.resolution.benefited],
          },
  },
});

const save = (context: ServiceContext, record: ClaimRecord): void => {
  context.store.documents.update(toDocument(record));
};

export function renderClaim(context: ServiceContext, record: ClaimRecord): Claim {
  const wire = WIRE[record.state];
  return {
    id: record.id,
    type: record.type,
    stage: wire.stage,
    status: wire.status,
    date_created: formatDateTime(record.createdAt),
    last_updated: formatDateTime(record.updatedAt),
    resource: 'payment',
    resource_id: record.paymentId,
    parent_id: null,
    site_id: 'MLB',
    reason_id: record.reasonId,
    players: [
      { role: 'complainant', user_id: record.buyerId, available_actions: ACTIONS[record.state].complainant },
      { role: 'respondent', user_id: context.collectorId, available_actions: ACTIONS[record.state].respondent },
    ],
    status_history: [...record.history],
    resolution:
      record.resolution === null
        ? null
        : {
            type: record.resolution.type,
            reason: record.resolution.reason,
            date_created: formatDateTime(record.resolution.at),
            benefited: [...record.resolution.benefited],
          },
  };
}

function locate(context: ServiceContext, id: string): Result<ClaimRecord, ErrorBody> {
  const document = context.store.documents.get('claim', id);
  if (document === null) return err(notFound('Claim not found'));
  return ok(readClaim(document));
}

const refuse = (error: ClaimError): ErrorBody =>
  unprocessable('operation not allowed', [{ code: 4051, description: `${error.kind}:${error.from}:${error.command}` }]);

const settled = (state: ClaimState): boolean => state === 'closed' || state === 'cancelled';

const tooLate = (state: ClaimState): ErrorBody =>
  unprocessable('the claim is no longer open', [{ code: 4054, description: `claim_${state}` }]);

/**
 * The real API has no public create endpoint — a claim is opened by the buyer from the
 * Mercado Pago front end. payground exposes creation so a test or the dashboard can put a
 * sandbox into the post-purchase flow at all.
 */
export function openClaim(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));
  const paymentId = readNumber(body, 'payment_id');
  if (paymentId === null) return err(badRequest('payment_id is required', [{ code: 4000, description: 'payment_id' }]));

  const payment = context.store.payments.bySequence(paymentId);
  if (payment === null) return err(notFound('Payment not found'));

  const reasonId = readString(body, 'reason_id') ?? CLAIM_REASONS[0]?.id ?? '';
  const reason = reasonById(reasonId);
  if (reason === null) return err(badRequest('unknown reason_id', [{ code: 4001, description: reasonId }]));

  const now = context.clock.now();
  const sequence = context.store.nextSequence('claim');
  const record: ClaimRecord = {
    id: CLAIM_BASE + sequence,
    state: 'opened',
    type: reason.type ?? 'claims',
    paymentId,
    buyerId: BUYER_BASE + sequence,
    reasonId,
    createdAt: now,
    updatedAt: now,
    history: [historyEntry('opened', now, 'buyer')],
    attachments: [],
    evidences: [],
    resolution: null,
  };

  context.store.documents.insert(toDocument(record));
  return ok({ status: 201, body: renderClaim(context, record) });
}

export function getClaim(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const record = locate(context, id);
  if (!record.ok) return record;
  return ok({ status: 200, body: renderClaim(context, record.value) });
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const MAX_SEARCH_SCAN = 1_000;

function integerParam(params: URLSearchParams, name: string, fallback: number, min = 0): Result<number, ErrorBody> {
  const raw = params.get(name);
  if (raw === null || raw === '') return ok(fallback);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    return err(badRequest(`${name} invalid`, [{ code: 4005, description: name }]));
  }
  return ok(parsed);
}

export function searchClaims(context: ServiceContext, params: URLSearchParams): Result<Rendered, ErrorBody> {
  const requested = integerParam(params, 'limit', DEFAULT_LIMIT, 1);
  if (!requested.ok) return requested;
  const limit = Math.min(requested.value, MAX_LIMIT);
  const offset = integerParam(params, 'offset', 0);
  if (!offset.ok) return offset;

  const id = params.get('id');
  const type = params.get('type');
  const stage = params.get('stage');
  const status = params.get('status');

  // The document store cannot filter on stage or type, so the window is scanned here; a
  // sandbox never holds enough claims for the cap to bite.
  const page = context.store.documents.search('claim', { limit: MAX_SEARCH_SCAN, offset: 0, order: 'desc' });
  const matched = page.results
    .map((document) => readClaim(document, false))
    .filter((record) => id === null || String(record.id) === id)
    .filter((record) => type === null || record.type === type)
    .filter((record) => stage === null || WIRE[record.state].stage === stage)
    .filter((record) => status === null || WIRE[record.state].status === status);

  const window = matched.slice(offset.value, offset.value + limit);
  return ok({
    status: 200,
    body: {
      paging: { total: matched.length, limit, offset: offset.value },
      results: window.map((record) => renderClaim(context, record)),
    },
  });
}

export function getClaimReasons(_context: ServiceContext, reasonId: string): Result<Rendered, ErrorBody> {
  if (reasonId === 'all') return ok({ status: 200, body: CLAIM_REASONS });
  const reason = reasonById(reasonId);
  if (reason === null) return err(notFound('Reason not found'));
  return ok({ status: 200, body: reason });
}

export function getClaimHistory(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const record = locate(context, id);
  if (!record.ok) return record;
  return ok({ status: 200, body: record.value.history });
}

/** The attachment responses key a file by `file_id`; `id` is kept so both readings work. */
const renderEvidence = (claimId: number, file: ClaimFile): ClaimEvidence => ({
  id: file.id,
  file_id: file.id,
  claim_id: claimId,
  type: file.type,
  date_created: formatDateTime(file.createdAt),
  file_name: file.fileName,
  content_type: file.contentType,
  size: file.size,
  value: file.value,
  description: file.description,
});

export function getClaimEvidence(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const record = locate(context, id);
  if (!record.ok) return record;
  return ok({
    status: 200,
    body: record.value.evidences.map((file) => renderEvidence(record.value.id, file)),
  });
}

function renderMessage(document: StoredDocument): ClaimMessage {
  const doc = document.doc;
  const role = readString(doc, 'sender_role');
  const sender: SenderRole = role === 'complainant' || role === 'mediator' ? role : 'respondent';
  const stage = readString(doc, 'stage');
  return {
    id: readNumber(doc, 'id') ?? 0,
    claim_id: readNumber(doc, 'claim_id') ?? 0,
    date_created: formatDateTime(readNumber(doc, 'created_at') ?? document.createdAt),
    from: { user_id: readNumber(doc, 'user_id') ?? 0, role: sender },
    sender_role: sender,
    receiver_role: sender === 'complainant' ? 'respondent' : 'complainant',
    stage: stage === 'dispute' || stage === 'resolution' ? stage : 'claim',
    message: readString(doc, 'message') ?? '',
    attachments: readObjects(doc, 'attachments').map((entry) => ({
      file_name: readString(entry, 'file_name') ?? '',
      file_id: readString(entry, 'file_id') ?? '',
    })),
  };
}

export function getClaimMessages(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const record = locate(context, id);
  if (!record.ok) return record;
  const page = context.store.documents.search('claim_message', {
    lookup: String(record.value.id),
    limit: 1_000,
    offset: 0,
    order: 'asc',
  });
  return ok({ status: 200, body: page.results.map(renderMessage) });
}

const ROLES: readonly SenderRole[] = ['complainant', 'respondent', 'mediator'];

/**
 * The real endpoint infers the sender from the token, which is always the seller. payground
 * has no buyer session, so an optional non-spec `sender_role` lets a test or the dashboard
 * write the other side of the thread.
 */
export function sendClaimMessage(context: ServiceContext, id: string, body: unknown): Result<Rendered, ErrorBody> {
  const record = locate(context, id);
  if (!record.ok) return record;
  if (settled(record.value.state)) return err(tooLate(record.value.state));

  const parsed = validateSendMessageRequest(body);
  if (!parsed.ok) {
    return err(badRequest('invalid request body', parsed.error.map((issue) => ({ code: 4006, description: `${issue.path} ${issue.message}` }))));
  }
  const message = parsed.value.message.trim();
  if (message === '') return err(badRequest('message is required', [{ code: 4007, description: 'message' }]));
  if (message.length > MAX_MESSAGE_LENGTH) {
    return err(badRequest('message is too long', [{ code: 4008, description: `max ${MAX_MESSAGE_LENGTH} characters` }]));
  }

  const requested = isJsonObject(body) ? readString(body, 'sender_role') : null;
  const sender: SenderRole = ROLES.find((role) => role === requested) ?? 'respondent';

  const attachments: JsonObject[] = [];
  for (const fileId of parsed.value.attachments ?? []) {
    const file = record.value.attachments.find((entry) => entry.id === fileId);
    if (file === undefined) return err(badRequest('unknown attachment', [{ code: 4009, description: fileId }]));
    attachments.push({ file_name: file.fileName, file_id: file.id });
  }

  const now = context.clock.now();
  const sequence = context.store.nextSequence('claim_message');
  const document: StoredDocument = {
    kind: 'claim_message',
    id: String(MESSAGE_BASE + sequence),
    sequence: MESSAGE_BASE + sequence,
    status: sender,
    externalReference: null,
    lookup: String(record.value.id),
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    doc: {
      id: MESSAGE_BASE + sequence,
      claim_id: record.value.id,
      sender_role: sender,
      stage: WIRE[record.value.state].stage,
      user_id: sender === 'complainant' ? record.value.buyerId : context.collectorId,
      message,
      created_at: now,
      attachments,
    },
  };

  context.store.documents.insert(document);
  save(context, { ...record.value, updatedAt: now });
  return ok({ status: 201, body: renderMessage(document) });
}

type Bucket = 'attachments' | 'evidences';

function append(
  context: ServiceContext,
  id: string,
  bucket: Bucket,
  make: (record: ClaimRecord) => Result<ClaimFile, ErrorBody>,
): Result<Rendered, ErrorBody> {
  const record = locate(context, id);
  if (!record.ok) return record;
  if (settled(record.value.state)) return err(tooLate(record.value.state));
  if (record.value[bucket].length >= MAX_ATTACHMENTS) {
    return err(badRequest('too many files', [{ code: 4010, description: `max ${MAX_ATTACHMENTS}` }]));
  }

  const entry = make(record.value);
  if (!entry.ok) return entry;
  if (
    entry.value.fileName !== null &&
    record.value[bucket].some((existing) => existing.fileName === entry.value.fileName)
  ) {
    return err(badRequest('a file with that name already exists', [{ code: 4011, description: entry.value.fileName }]));
  }

  const updated: ClaimRecord = {
    ...record.value,
    [bucket]: [...record.value[bucket], entry.value],
    updatedAt: context.clock.now(),
  };
  save(context, updated);
  return ok({ status: 201, body: renderEvidence(updated.id, entry.value) });
}

export function attachClaimFile(context: ServiceContext, id: string, upload: UploadedFile): Result<Rendered, ErrorBody> {
  return append(context, id, 'attachments', () => toFile(context, upload, 'other', null));
}

/** payground extension: the spec's evidence body is JSON, a file is accepted as well. */
export function uploadEvidenceFile(
  context: ServiceContext,
  id: string,
  upload: UploadedFile,
  type: EvidenceType,
  description: string | null,
): Result<Rendered, ErrorBody> {
  return append(context, id, 'evidences', () => toFile(context, upload, type, description));
}

const SHIPPING_EVIDENCE_TYPES: readonly EvidenceType[] = ['tracking_code', 'proof_of_delivery'];

/** The spec's body is `{ type, value }` in JSON: a tracking code, not an upload. */
export function uploadShippingEvidence(context: ServiceContext, id: string, body: unknown): Result<Rendered, ErrorBody> {
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));
  const type = SHIPPING_EVIDENCE_TYPES.find((candidate) => candidate === readString(body, 'type'));
  if (type === undefined) {
    return err(badRequest('type must be tracking_code or proof_of_delivery', [{ code: 4015, description: 'type' }]));
  }
  const value = (readString(body, 'value') ?? '').trim();
  if (value === '') return err(badRequest('value is required', [{ code: 4016, description: 'value' }]));
  if (value.length > MAX_MESSAGE_LENGTH) {
    return err(badRequest('value is too long', [{ code: 4017, description: `max ${MAX_MESSAGE_LENGTH} characters` }]));
  }

  return append(context, id, 'evidences', () =>
    ok({
      id: context.ids.uuid(),
      createdAt: context.clock.now(),
      type,
      description: readString(body, 'description'),
      fileName: null,
      contentType: null,
      size: null,
      data: null,
      value,
    }),
  );
}

function findFile(context: ServiceContext, id: string, fileName: string): Result<{ record: ClaimRecord; file: ClaimFile }, ErrorBody> {
  const record = locate(context, id);
  if (!record.ok) return record;
  const safe = sanitizeFileName(fileName);
  const file = safe === null ? undefined : record.value.attachments.find((entry) => entry.fileName === safe);
  if (file === undefined) return err(notFound('Attachment not found'));
  return ok({ record: record.value, file });
}

export function getClaimFile(context: ServiceContext, id: string, fileName: string): Result<Rendered, ErrorBody> {
  const found = findFile(context, id, fileName);
  if (!found.ok) return found;
  return ok({ status: 200, body: renderEvidence(found.value.record.id, found.value.file) });
}

export interface FileDownload {
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export function downloadClaimFile(context: ServiceContext, id: string, fileName: string): Result<FileDownload, ErrorBody> {
  const found = findFile(context, id, fileName);
  if (!found.ok) return found;
  const { file } = found.value;
  if (file.fileName === null || file.data === null) return err(notFound('Attachment not found'));
  return ok({
    fileName: file.fileName,
    contentType: file.contentType ?? 'application/octet-stream',
    bytes: new Uint8Array(Buffer.from(file.data, 'base64')),
  });
}

const commitPayment = (context: ServiceContext, transition: Transition): void => {
  context.store.payments.update(transition.payment);
  context.store.payments.record(transition);
};

function paymentFor(context: ServiceContext, record: ClaimRecord): Result<Payment, ErrorBody> {
  const payment = context.store.payments.bySequence(record.paymentId);
  if (payment === null) return err(notFound('Payment not found'));
  return ok(payment);
}

/** Escalating puts the claim in dispute and the payment on hold, both through the domain. */
export function requestClaimMediation(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const record = locate(context, id);
  if (!record.ok) return record;

  const now = context.clock.now();
  const moved = applyClaim(record.value, 'escalate', now, 'buyer');
  if (!moved.ok) return err(refuse(moved.error));

  const payment = paymentFor(context, record.value);
  if (!payment.ok) return payment;
  const disputed = apply(payment.value, { type: 'dispute' }, now);
  if (!disputed.ok) {
    return err(unprocessable('the payment cannot enter mediation', [{ code: 4052, description: disputed.error.kind }]));
  }

  commitPayment(context, disputed.value);
  save(context, moved.value);
  return ok({ status: 200, body: renderClaim(context, moved.value) });
}

export function getClaimMediationResolutions(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const record = locate(context, id);
  if (!record.ok) return record;
  if (record.value.state !== 'dispute') return ok({ status: 200, body: [] });

  const payment = paymentFor(context, record.value);
  if (!payment.ok) return payment;
  // What a resolution can actually move is what is left to refund, not the original amount.
  const total = toDecimal(refundable(payment.value));
  const options: MediationResolution[] = [
    {
      id: 'refund_total',
      type: 'refund',
      amount: total,
      currency_id: payment.value.currency,
      reason: record.value.reasonId,
      benefited: 'complainant',
    },
    {
      id: 'partial_refund',
      type: 'partial_refund',
      amount: Math.round(total * 50) / 100,
      currency_id: payment.value.currency,
      reason: record.value.reasonId,
      benefited: 'complainant',
    },
    {
      id: 'return_product',
      type: 'return',
      amount: total,
      currency_id: payment.value.currency,
      reason: record.value.reasonId,
      benefited: 'complainant',
    },
  ];
  return ok({ status: 200, body: options });
}

export type ClaimOutcome = 'complainant' | 'respondent';

/**
 * A mediation ends before the money moves: `resolve` is the only command the domain allows
 * from `in_mediation`, so the hold is lifted first and a buyer win is then settled with a
 * real refund — Mercado Pago refunds a claim resolved for the buyer, a chargeback is the
 * card network's path and not this one. The payment may already have left mediation through
 * the control API, so the claim closes either way rather than wedging in `dispute`.
 */
export function resolveClaim(context: ServiceContext, id: string, outcome: ClaimOutcome): Result<Rendered, ErrorBody> {
  const record = locate(context, id);
  if (!record.ok) return record;

  const now = context.clock.now();
  const moved = applyClaim(record.value, 'resolve', now, 'mediator');
  if (!moved.ok) return err(refuse(moved.error));

  const found = paymentFor(context, record.value);
  if (!found.ok) return found;

  let payment = found.value;
  if (payment.status.state === 'in_mediation') {
    const lifted = apply(payment, { type: 'resolve', outcome: 'merchant' }, now);
    if (!lifted.ok) {
      return err(unprocessable('the payment cannot leave mediation', [{ code: 4053, description: lifted.error.kind }]));
    }
    commitPayment(context, lifted.value);
    payment = lifted.value.payment;
  }

  if (outcome === 'complainant' && refundable(payment) > 0) {
    const refunded = createRefund(context, String(record.value.paymentId), {});
    if (!refunded.ok) return refunded;
  }

  const resolved: ClaimRecord = {
    ...moved.value,
    resolution: {
      type: outcome === 'complainant' ? 'refund' : 'seller_favour',
      reason: record.value.reasonId,
      at: now,
      benefited: [outcome],
    },
  };
  save(context, resolved);
  return ok({ status: 200, body: renderClaim(context, resolved) });
}
