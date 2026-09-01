import {
  type JsonObject,
  type Result,
  type StoredDocument,
  err,
  fromDecimal,
  isJsonObject,
  ok,
  refundable,
  toDecimal,
} from '@payground/core';
import { type ErrorBody, badRequest, conflict, errorBody, notFound, serverError } from '../errors.ts';
import { formatDateTime } from '../serialize/datetime.ts';
import { createCardToken } from './card-tokens.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { readNumber, readObject, readString } from './document.ts';
import { createPayment, createRefund } from './payments.ts';

export type IntentState = 'OPEN' | 'ON_TERMINAL' | 'PROCESSING' | 'FINISHED' | 'CANCELED' | 'ERROR';
export type IntentCommand = 'deliver' | 'process' | 'finish' | 'cancel' | 'fail';

/** The card reader lifecycle, as data. Nothing transitions unless it is listed here. */
export const INTENT_TRANSITIONS = {
  OPEN: ['deliver', 'cancel', 'fail'],
  ON_TERMINAL: ['process', 'cancel', 'fail'],
  // Once the card is being read the terminal owns the intent and refuses a cancellation.
  PROCESSING: ['finish', 'fail'],
  FINISHED: [],
  CANCELED: [],
  ERROR: [],
} as const satisfies Record<IntentState, readonly IntentCommand[]>;

const INTENT_RESULT = {
  deliver: 'ON_TERMINAL',
  process: 'PROCESSING',
  finish: 'FINISHED',
  cancel: 'CANCELED',
  fail: 'ERROR',
} as const satisfies Record<IntentCommand, IntentState>;

export interface IllegalTransition {
  readonly kind: 'illegal_transition';
  readonly from: IntentState;
  readonly command: IntentCommand;
}

export const isIntentState = (value: string): value is IntentState =>
  Object.hasOwn(INTENT_TRANSITIONS, value);
export const isIntentCommand = (value: string): value is IntentCommand =>
  Object.hasOwn(INTENT_RESULT, value);
export const isIntentTerminal = (state: IntentState): boolean => INTENT_TRANSITIONS[state].length === 0;

export function nextIntentState(
  from: IntentState,
  command: IntentCommand,
): Result<IntentState, IllegalTransition> {
  const allowed: readonly IntentCommand[] = INTENT_TRANSITIONS[from];
  if (!allowed.includes(command)) return err({ kind: 'illegal_transition', from, command });
  return ok(INTENT_RESULT[command]);
}

export type ActionStatus = 'pending' | 'sent' | 'printed' | 'failed' | 'canceled';
export type ActionCommand = 'send' | 'print' | 'fail' | 'cancel';

export const ACTION_TRANSITIONS = {
  pending: ['send', 'cancel', 'fail'],
  sent: ['print', 'fail'],
  printed: [],
  failed: [],
  canceled: [],
} as const satisfies Record<ActionStatus, readonly ActionCommand[]>;

const ACTION_RESULT = {
  send: 'sent',
  print: 'printed',
  fail: 'failed',
  cancel: 'canceled',
} as const satisfies Record<ActionCommand, ActionStatus>;

export const isActionStatus = (value: string): value is ActionStatus =>
  Object.hasOwn(ACTION_TRANSITIONS, value);
export const isActionCommand = (value: string): value is ActionCommand =>
  Object.hasOwn(ACTION_RESULT, value);

export function nextActionStatus(
  from: ActionStatus,
  command: ActionCommand,
): Result<ActionStatus, { kind: 'illegal_transition'; from: ActionStatus; command: ActionCommand }> {
  const allowed: readonly ActionCommand[] = ACTION_TRANSITIONS[from];
  if (!allowed.includes(command)) return err({ kind: 'illegal_transition', from, command });
  return ok(ACTION_RESULT[command]);
}

export type OperatingMode = 'PDV' | 'STANDALONE';

const DEVICE_LOOKUP = 'device';
const ACTION_LOOKUP = 'action';
const POS_BASE = 50_000_000;
const STORE_BASE = 60_000_000;
const MAX_INSTALLMENTS = 24;
const ACTIVE: readonly IntentState[] = ['OPEN', 'ON_TERMINAL', 'PROCESSING'];
const PAYMENT_TYPES: readonly string[] = ['credit_card', 'debit_card'];
const ACTION_TYPES: readonly string[] = ['PRINT_INFO', 'PRINT_DTE'];

/** Device ids are `MODEL__SERIAL`; a Point account is seeded with a small fleet of readers. */
const SEEDED_DEVICES: readonly { id: string; operatingMode: OperatingMode }[] = [
  { id: 'PAX_A910__SMARTPOS1471016179', operatingMode: 'PDV' },
  { id: 'PAX_A910__SMARTPOS1471016180', operatingMode: 'PDV' },
  { id: 'PAX_A910__SMARTPOS1471016181', operatingMode: 'STANDALONE' },
];

const POINT_PAYER_EMAIL = 'point@payground.local';

/**
 * A Point payment never tokenises a card through the API, so the emulator mints a token
 * from the documented approving test card to reach `createPayment` unchanged.
 * https://www.mercadopago.com.br/developers/en/docs/your-integrations/test/cards
 */
const POINT_CARD = { number: '5480832801033311', securityCode: '123', holder: 'APRO' };

const isOperatingMode = (value: unknown): value is OperatingMode =>
  value === 'PDV' || value === 'STANDALONE';

function seedDevices(context: ServiceContext): void {
  const now = context.clock.now();
  SEEDED_DEVICES.forEach((device, index) => {
    // Per device rather than "any device exists", so an interrupted seed still completes.
    if (context.store.documents.get('terminal', device.id) !== null) return;
    try {
      context.store.documents.insert({
        kind: 'terminal',
        id: device.id,
        sequence: context.store.nextSequence('terminal'),
        status: 'active',
        externalReference: null,
        lookup: DEVICE_LOOKUP,
        createdAt: now,
        updatedAt: now,
        expiresAt: null,
        doc: {
          id: device.id,
          pos_id: POS_BASE + index,
          store_id: String(STORE_BASE + index),
          external_pos_id: `SUC001POS00${index + 1}`,
          operating_mode: device.operatingMode,
        },
      });
    } catch {
      // Another process serving the same sandbox won the race; its row is identical.
    }
  });
}

function deviceList(context: ServiceContext): readonly StoredDocument[] {
  seedDevices(context);
  return context.store.documents.search('terminal', {
    lookup: DEVICE_LOOKUP,
    limit: 1000,
    order: 'asc',
  }).results;
}

function deviceById(context: ServiceContext, id: string): StoredDocument | null {
  seedDevices(context);
  const found = context.store.documents.get('terminal', id);
  return found === null || found.lookup !== DEVICE_LOOKUP ? null : found;
}

const deviceView = (doc: JsonObject): JsonObject => ({
  id: readString(doc, 'id'),
  pos_id: readNumber(doc, 'pos_id'),
  store_id: readString(doc, 'store_id'),
  external_pos_id: readString(doc, 'external_pos_id'),
  operating_mode: readString(doc, 'operating_mode'),
});

interface Window {
  limit: number;
  offset: number;
}

function window(params: URLSearchParams): Result<Window, ErrorBody> {
  const limit = params.has('limit') ? Number(params.get('limit')) : 50;
  const offset = params.has('offset') ? Number(params.get('offset')) : 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return err(badRequest('invalid parameters', [{ code: 2034, description: 'limit invalid' }]));
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return err(badRequest('invalid parameters', [{ code: 2034, description: 'offset invalid' }]));
  }
  return ok({ limit, offset });
}

export function listPointDevices(
  context: ServiceContext,
  params: URLSearchParams,
): Result<Rendered, ErrorBody> {
  const page = window(params);
  if (!page.ok) return page;

  const matched = deviceList(context).filter(
    (device) =>
      (!params.has('store_id') || readString(device.doc, 'store_id') === params.get('store_id')) &&
      (!params.has('pos_id') || String(readNumber(device.doc, 'pos_id')) === params.get('pos_id')),
  );
  const { limit, offset } = page.value;

  return ok({
    status: 200,
    body: {
      devices: matched.slice(offset, offset + limit).map((device) => deviceView(device.doc)),
      paging: { total: matched.length, limit, offset },
    },
  });
}

export function listTerminals(
  context: ServiceContext,
  params: URLSearchParams,
): Result<Rendered, ErrorBody> {
  const page = window(params);
  if (!page.ok) return page;
  const { limit, offset } = page.value;
  const matched = deviceList(context);

  return ok({
    status: 200,
    body: {
      data: {
        terminals: matched
          .slice(offset, offset + limit)
          .map((device) => ({ ...deviceView(device.doc), status: device.status })),
      },
      paging: { total: matched.length, limit, offset },
    },
  });
}

export function updateTerminalOperationMode(
  context: ServiceContext,
  body: unknown,
): Result<Rendered, ErrorBody> {
  const request = isJsonObject(body) ? body : {};
  const entries = request['terminals'];
  if (!Array.isArray(entries) || entries.length === 0) {
    return err(badRequest('invalid parameters', [{ code: 2034, description: 'terminals is required' }]));
  }

  const changes: { document: StoredDocument; mode: OperatingMode }[] = [];
  for (const entry of entries) {
    if (!isJsonObject(entry)) {
      return err(badRequest('invalid parameters', [{ code: 2034, description: 'terminals[] must be objects' }]));
    }
    const id = readString(entry, 'id');
    const mode = entry['operating_mode'];
    if (id === null || !isOperatingMode(mode)) {
      return err(
        badRequest('invalid parameters', [
          { code: 2034, description: 'terminals[] require id and operating_mode' },
        ]),
      );
    }
    const device = deviceById(context, id);
    if (device === null) return err(notFound('Terminal not found'));
    changes.push({ document: device, mode });
  }

  const now = context.clock.now();
  const terminals = changes.map(({ document, mode }) => {
    context.store.documents.update({
      ...document,
      updatedAt: now,
      doc: { ...document.doc, operating_mode: mode },
    });
    return { id: document.id, operating_mode: mode };
  });

  return ok({ status: 200, body: { data: { terminals } } });
}

type IntentKind = 'payment' | 'refund';

const kindOf = (document: StoredDocument): IntentKind =>
  readString(document.doc, 'intent') === 'refund' ? 'refund' : 'payment';

const stateOf = (document: StoredDocument): IntentState =>
  isIntentState(document.status) ? document.status : 'ERROR';

const busy = (context: ServiceContext, deviceId: string): boolean =>
  ACTIVE.some(
    (state) =>
      context.store.documents.search('point_intent', { lookup: deviceId, status: state, limit: 1 })
        .total > 0,
  );

function locateIntent(
  context: ServiceContext,
  id: string,
  kind: IntentKind,
): Result<StoredDocument, ErrorBody> {
  const found = context.store.documents.get('point_intent', id);
  const missing = kind === 'refund' ? 'Refund intent not found' : 'Payment intent not found';
  if (found === null || kindOf(found) !== kind) return err(notFound(missing));
  return ok(found);
}

function settlePayment(context: ServiceContext, doc: JsonObject): Result<number, ErrorBody> {
  const now = context.clock.now();
  const token = createCardToken(context, {
    card_number: POINT_CARD.number,
    expiration_month: 12,
    expiration_year: new Date(now).getUTCFullYear() + 3,
    security_code: POINT_CARD.securityCode,
    cardholder: { name: POINT_CARD.holder },
  });
  if (!token.ok) return token;
  const tokenId = isJsonObject(token.value.body) ? readString(token.value.body, 'id') : null;
  if (tokenId === null) return err(serverError('the point card token was not minted'));

  const payment = readObject(doc, 'payment');
  const description = readString(doc, 'description');
  const externalReference = readString(readObject(doc, 'additional_info'), 'external_reference');

  const created = createPayment(context, {
    transaction_amount: (readNumber(doc, 'amount') ?? 0) / 100,
    token: tokenId,
    payment_method_id: readString(payment, 'type') === 'debit_card' ? 'debmaster' : 'master',
    installments: readNumber(payment, 'installments') ?? 1,
    payer: { email: POINT_PAYER_EMAIL },
    ...(description === null ? {} : { description }),
    ...(externalReference === null ? {} : { external_reference: externalReference }),
  });
  if (!created.ok) return created;

  const id = isJsonObject(created.value.body) ? readNumber(created.value.body, 'id') : null;
  return id === null ? err(serverError('the point payment was not created')) : ok(id);
}

function settleRefund(context: ServiceContext, doc: JsonObject): Result<number, ErrorBody> {
  const paymentId = readNumber(doc, 'payment_id');
  if (paymentId === null) return err(serverError('the refund intent has no payment'));
  const amount = readNumber(doc, 'amount');

  const created = createRefund(context, String(paymentId), amount === null ? {} : { amount });
  if (!created.ok) return created;

  const id = isJsonObject(created.value.body) ? readNumber(created.value.body, 'id') : null;
  return id === null ? err(serverError('the point refund was not created')) : ok(id);
}

/** Applies one command to an intent. An illegal transition is rejected, never written. */
function advance(
  context: ServiceContext,
  document: StoredDocument,
  command: IntentCommand,
): Result<StoredDocument, ErrorBody> {
  const from = stateOf(document);
  const next = nextIntentState(from, command);
  if (!next.ok) {
    return err(
      errorBody(409, 'conflict', `cannot ${command} an intent in state ${from}`, [
        { code: 4051, description: next.error.kind },
      ]),
    );
  }

  let state: IntentState = next.value;
  let extra: JsonObject = {};
  if (state === 'FINISHED') {
    const settled = kindOf(document) === 'refund' ? settleRefund(context, document.doc) : settlePayment(context, document.doc);
    if (settled.ok) {
      extra = kindOf(document) === 'refund' ? { refund_id: settled.value } : { payment_id: settled.value };
    } else {
      // The reader reports ERROR when the operation it was asked to perform is refused.
      state = 'ERROR';
      extra = { error: settled.error.message };
    }
  }

  const now = context.clock.now();
  const updated: StoredDocument = {
    ...document,
    status: state,
    updatedAt: now,
    doc: { ...document.doc, ...extra, state, updated_on: formatDateTime(now) },
  };
  context.store.documents.update(updated);
  return ok(updated);
}

function paymentIntentView(doc: JsonObject): JsonObject {
  const paymentId = readNumber(doc, 'payment_id');
  return {
    id: readString(doc, 'id'),
    device_id: readString(doc, 'device_id'),
    amount: readNumber(doc, 'amount'),
    description: readString(doc, 'description'),
    payment_mode: null,
    additional_info: readObject(doc, 'additional_info'),
    payment: { ...readObject(doc, 'payment'), ...(paymentId === null ? {} : { id: paymentId }) },
    state: readString(doc, 'state'),
    error: readString(doc, 'error'),
  };
}

const refundIntentView = (doc: JsonObject): JsonObject => ({
  id: readString(doc, 'id'),
  device_id: readString(doc, 'device_id'),
  payment_id: readNumber(doc, 'payment_id'),
  amount: readNumber(doc, 'amount'),
  refund_id: readNumber(doc, 'refund_id'),
  status: (readString(doc, 'state') ?? 'ERROR').toLowerCase(),
  error: readString(doc, 'error'),
});

export const intentView = (document: StoredDocument): JsonObject =>
  kindOf(document) === 'refund' ? refundIntentView(document.doc) : paymentIntentView(document.doc);

export function createPointPaymentIntent(
  context: ServiceContext,
  deviceId: string,
  body: unknown,
): Result<Rendered, ErrorBody> {
  const device = deviceById(context, deviceId);
  if (device === null) return err(notFound('Device not found'));
  if (readString(device.doc, 'operating_mode') !== 'PDV') {
    return err(conflict('the device is not in PDV operating mode'));
  }

  const request = isJsonObject(body) ? body : {};
  const amount = readNumber(request, 'amount');
  if (amount === null || !Number.isInteger(amount) || amount <= 0) {
    return err(
      badRequest('invalid parameters', [
        { code: 3003, description: 'amount must be a positive integer in cents' },
      ]),
    );
  }

  const payment = readObject(request, 'payment');
  const type = readString(payment, 'type') ?? 'credit_card';
  if (!PAYMENT_TYPES.includes(type)) {
    return err(badRequest('invalid parameters', [{ code: 3004, description: 'payment.type invalid' }]));
  }
  const installments = readNumber(payment, 'installments') ?? 1;
  if (!Number.isInteger(installments) || installments < 1 || installments > MAX_INSTALLMENTS) {
    return err(
      badRequest('invalid parameters', [
        { code: 3006, description: `payment.installments must be between 1 and ${MAX_INSTALLMENTS}` },
      ]),
    );
  }
  if (busy(context, deviceId)) {
    return err(conflict('the device already has an open intent'));
  }

  const info = readObject(request, 'additional_info');
  const externalReference = readString(info, 'external_reference');
  const now = context.clock.now();
  const id = context.ids.uuid();
  const document: StoredDocument = {
    kind: 'point_intent',
    id,
    sequence: context.store.nextSequence('point_intent'),
    status: 'OPEN',
    externalReference,
    lookup: deviceId,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    doc: {
      intent: 'payment',
      id,
      device_id: deviceId,
      amount,
      description: readString(request, 'description'),
      state: 'OPEN',
      payment_id: null,
      payment: {
        installments,
        installments_cost: readString(payment, 'installments_cost') ?? 'seller',
        type,
      },
      // The spec puts print_on_terminal at the top level; the API and the SDK nest it.
      additional_info: {
        external_reference: externalReference,
        print_on_terminal: info['print_on_terminal'] === true || request['print_on_terminal'] === true,
      },
      created_on: formatDateTime(now),
      updated_on: formatDateTime(now),
    },
  };
  context.store.documents.insert(document);

  return ok({ status: 201, body: paymentIntentView(document.doc) });
}

export function getPointPaymentIntent(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const found = locateIntent(context, id, 'payment');
  if (!found.ok) return found;
  return ok({ status: 200, body: paymentIntentView(found.value.doc) });
}

export function cancelPointPaymentIntent(
  context: ServiceContext,
  deviceId: string,
  id: string,
): Result<Rendered, ErrorBody> {
  const found = locateIntent(context, id, 'payment');
  if (!found.ok) return found;
  if (readString(found.value.doc, 'device_id') !== deviceId) return err(notFound('Payment intent not found'));

  const cancelled = advance(context, found.value, 'cancel');
  if (!cancelled.ok) return cancelled;
  return ok({ status: 200, body: { id: cancelled.value.id } });
}

export function createPointRefundIntent(
  context: ServiceContext,
  deviceId: string,
  body: unknown,
): Result<Rendered, ErrorBody> {
  const device = deviceById(context, deviceId);
  if (device === null) return err(notFound('Device not found'));
  if (readString(device.doc, 'operating_mode') !== 'PDV') {
    return err(conflict('the device is not in PDV operating mode'));
  }

  const request = isJsonObject(body) ? body : {};
  const paymentId = readNumber(request, 'payment_id');
  if (paymentId === null || !Number.isInteger(paymentId)) {
    return err(badRequest('invalid parameters', [{ code: 2034, description: 'payment_id is required' }]));
  }
  const payment = context.store.payments.bySequence(paymentId);
  if (payment === null) return err(notFound('Payment not found'));

  const raw = request['amount'];
  if (raw !== undefined && (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0)) {
    return err(badRequest('invalid parameters', [{ code: 2034, description: 'amount invalid' }]));
  }
  // The intent amount is in cents but a refund amount is in major units; catching an
  // over-refund here turns the easy confusion into a 400 instead of a late ERROR state.
  const parsed = typeof raw === 'number' ? fromDecimal(raw) : null;
  if (parsed !== null && (!parsed.ok || parsed.value > refundable(payment))) {
    return err(
      badRequest('invalid parameters', [
        { code: 2034, description: `amount exceeds the refundable ${toDecimal(refundable(payment))}` },
      ]),
    );
  }
  const amount = typeof raw === 'number' ? raw : null;
  if (busy(context, deviceId)) return err(conflict('the device already has an open intent'));

  const now = context.clock.now();
  const id = context.ids.uuid();
  const document: StoredDocument = {
    kind: 'point_intent',
    id,
    sequence: context.store.nextSequence('point_intent'),
    status: 'OPEN',
    externalReference: null,
    lookup: deviceId,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    doc: {
      intent: 'refund',
      id,
      device_id: deviceId,
      payment_id: paymentId,
      amount,
      refund_id: null,
      state: 'OPEN',
      created_on: formatDateTime(now),
      updated_on: formatDateTime(now),
    },
  };
  context.store.documents.insert(document);

  return ok({ status: 200, body: refundIntentView(document.doc) });
}

export function getPointRefundIntent(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const found = locateIntent(context, id, 'refund');
  if (!found.ok) return found;
  return ok({ status: 200, body: refundIntentView(found.value.doc) });
}

export function cancelPointRefundIntent(
  context: ServiceContext,
  deviceId: string,
  id: string,
): Result<Rendered, ErrorBody> {
  const found = locateIntent(context, id, 'refund');
  if (!found.ok) return found;
  if (readString(found.value.doc, 'device_id') !== deviceId) return err(notFound('Refund intent not found'));

  const cancelled = advance(context, found.value, 'cancel');
  if (!cancelled.ok) return cancelled;
  return ok({ status: 200, body: { id: cancelled.value.id } });
}

/** Drives an intent through its state machine. Exposed so the control API can act as the reader. */
export function driveIntent(
  context: ServiceContext,
  id: string,
  command: string,
): Result<Rendered, ErrorBody> {
  if (!isIntentCommand(command)) {
    return err(badRequest('invalid parameters', [{ code: 2034, description: `unknown command ${command}` }]));
  }
  const found = context.store.documents.get('point_intent', id);
  if (found === null) return err(notFound('Payment intent not found'));

  const moved = advance(context, found, command);
  if (!moved.ok) return moved;
  return ok({ status: 200, body: intentView(moved.value) });
}

export function listIntents(context: ServiceContext, params: URLSearchParams): Result<Rendered, ErrorBody> {
  const page = window(params);
  if (!page.ok) return page;
  const found = context.store.documents.search('point_intent', {
    ...page.value,
    ...(params.has('device_id') ? { lookup: params.get('device_id') as string } : {}),
    ...(params.has('state') ? { status: params.get('state') as string } : {}),
    order: 'desc',
  });
  return ok({
    status: 200,
    body: {
      results: found.results.map(intentView),
      paging: { total: found.total, limit: found.limit, offset: found.offset },
    },
  });
}

const actionView = (doc: JsonObject): JsonObject => ({
  id: readString(doc, 'id'),
  action: readString(doc, 'action'),
  type: readString(doc, 'action'),
  status: readString(doc, 'status'),
  terminal_id: readString(doc, 'terminal_id'),
  external_reference: readString(doc, 'external_reference'),
  content: readObject(doc, 'content'),
  date_created: readString(doc, 'date_created'),
  date_last_updated: readString(doc, 'date_last_updated'),
});

function locateAction(context: ServiceContext, id: string): Result<StoredDocument, ErrorBody> {
  const found = context.store.documents.get('terminal', id);
  if (found === null || found.lookup !== ACTION_LOOKUP) return err(notFound('Action not found'));
  return ok(found);
}

export function createTerminalAction(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  const request = isJsonObject(body) ? body : {};
  // The spec calls the field `type`; the Terminals guide calls it `action`. Both are accepted.
  const action = readString(request, 'type') ?? readString(request, 'action');
  if (action === null || !ACTION_TYPES.includes(action)) {
    return err(badRequest('invalid parameters', [{ code: 2034, description: 'type invalid' }]));
  }
  const externalReference = readString(request, 'external_reference');
  if (externalReference === null) {
    return err(
      badRequest('invalid parameters', [{ code: 2034, description: 'external_reference is required' }]),
    );
  }
  const terminalId = readString(readObject(request, 'config'), 'device_id') ?? readString(request, 'terminal_id');
  if (terminalId === null || deviceById(context, terminalId) === null) {
    return err(notFound('Terminal not found'));
  }

  const now = context.clock.now();
  const id = context.ids.uuid();
  const document: StoredDocument = {
    kind: 'terminal',
    id,
    sequence: context.store.nextSequence('terminal'),
    status: 'pending',
    externalReference,
    lookup: ACTION_LOOKUP,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    doc: {
      id,
      action,
      status: 'pending',
      terminal_id: terminalId,
      external_reference: externalReference,
      content: readObject(request, 'content'),
      date_created: formatDateTime(now),
      date_last_updated: formatDateTime(now),
    },
  };
  context.store.documents.insert(document);

  return ok({ status: 200, body: actionView(document.doc) });
}

export function getTerminalAction(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const found = locateAction(context, id);
  if (!found.ok) return found;
  return ok({ status: 200, body: actionView(found.value.doc) });
}

function moveAction(
  context: ServiceContext,
  document: StoredDocument,
  command: ActionCommand,
): Result<StoredDocument, ErrorBody> {
  const from = isActionStatus(document.status) ? document.status : 'failed';
  const next = nextActionStatus(from, command);
  if (!next.ok) {
    return err(
      errorBody(409, 'conflict', `cannot ${command} an action in status ${from}`, [
        { code: 4051, description: next.error.kind },
      ]),
    );
  }
  const now = context.clock.now();
  const updated: StoredDocument = {
    ...document,
    status: next.value,
    updatedAt: now,
    doc: { ...document.doc, status: next.value, date_last_updated: formatDateTime(now) },
  };
  context.store.documents.update(updated);
  return ok(updated);
}

export function cancelTerminalAction(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const found = locateAction(context, id);
  if (!found.ok) return found;
  const moved = moveAction(context, found.value, 'cancel');
  if (!moved.ok) return moved;
  return ok({ status: 200, body: actionView(moved.value.doc) });
}

/** Drives a print job. Exposed so the control API can act as the terminal. */
export function driveTerminalAction(
  context: ServiceContext,
  id: string,
  command: string,
): Result<Rendered, ErrorBody> {
  if (!isActionCommand(command)) {
    return err(badRequest('invalid parameters', [{ code: 2034, description: `unknown command ${command}` }]));
  }
  const found = locateAction(context, id);
  if (!found.ok) return found;
  const moved = moveAction(context, found.value, command);
  if (!moved.ok) return moved;
  return ok({ status: 200, body: actionView(moved.value.doc) });
}
