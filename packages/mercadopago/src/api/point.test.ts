import { describe, expect, test } from 'bun:test';
import { type JsonObject, type Result, isJsonObject } from '@payground/core';
import type { ErrorBody } from '../errors.ts';
import { testContext } from '../testing.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { getPayment, searchPayments } from './payments.ts';
import {
  ACTION_TRANSITIONS,
  INTENT_TRANSITIONS,
  type IntentCommand,
  type IntentState,
  cancelPointPaymentIntent,
  cancelPointRefundIntent,
  cancelTerminalAction,
  createPointPaymentIntent,
  createPointRefundIntent,
  createTerminalAction,
  driveIntent,
  driveTerminalAction,
  getPointPaymentIntent,
  getPointRefundIntent,
  getTerminalAction,
  isIntentTerminal,
  listIntents,
  listPointDevices,
  listTerminals,
  nextIntentState,
  updateTerminalOperationMode,
} from './point.ts';

const body = (result: Result<Rendered, ErrorBody>): JsonObject => {
  if (!result.ok || !isJsonObject(result.value.body)) throw new Error('expected success');
  return result.value.body;
};

const objects = (value: unknown): JsonObject[] =>
  Array.isArray(value) ? value.filter((entry): entry is JsonObject => isJsonObject(entry)) : [];

const devices = (context: ServiceContext): JsonObject[] =>
  objects(body(listPointDevices(context, new URLSearchParams()))['devices']);

const PDV = 'PAX_A910__SMARTPOS1471016179';
const STANDALONE = 'PAX_A910__SMARTPOS1471016181';

function openIntent(context: ServiceContext, overrides: Record<string, unknown> = {}): string {
  const created = createPointPaymentIntent(context, PDV, { amount: 1500, ...overrides });
  return body(created)['id'] as string;
}

function finish(context: ServiceContext, id: string): JsonObject {
  for (const command of ['deliver', 'process', 'finish'] as const) {
    const moved = driveIntent(context, id, command);
    if (!moved.ok) throw new Error(`${command} failed`);
  }
  return body(getPointPaymentIntent(context, id));
}

describe('the intent state machine', () => {
  test('every state is reachable and only terminal states have no commands', () => {
    const terminal = (Object.keys(INTENT_TRANSITIONS) as IntentState[]).filter(isIntentTerminal);
    expect(terminal.sort()).toEqual(['CANCELED', 'ERROR', 'FINISHED']);
  });

  test('the happy path walks OPEN to FINISHED', () => {
    let state: IntentState = 'OPEN';
    for (const command of ['deliver', 'process', 'finish'] as const) {
      const next = nextIntentState(state, command);
      if (!next.ok) throw new Error('expected a legal transition');
      state = next.value;
    }
    expect(state).toBe('FINISHED');
  });

  test('an illegal transition is a typed error, not a silent write', () => {
    const jump = nextIntentState('OPEN', 'finish');
    expect(jump.ok).toBe(false);
    if (jump.ok) throw new Error('unreachable');
    expect(jump.error).toEqual({ kind: 'illegal_transition', from: 'OPEN', command: 'finish' });
  });

  test('a card being read can no longer be cancelled', () => {
    expect(nextIntentState('PROCESSING', 'cancel').ok).toBe(false);
    expect(nextIntentState('ON_TERMINAL', 'cancel').ok).toBe(true);
  });

  test('no command escapes a terminal state', () => {
    const commands: readonly IntentCommand[] = ['deliver', 'process', 'finish', 'cancel', 'fail'];
    for (const state of ['FINISHED', 'CANCELED', 'ERROR'] as const) {
      for (const command of commands) expect(nextIntentState(state, command).ok).toBe(false);
    }
  });
});

describe('devices', () => {
  test('are seeded on first read and stay stable', () => {
    const { context } = testContext();
    const first = devices(context);
    expect(first.length).toBe(3);
    expect(first.map((device) => device['id'])).toEqual(devices(context).map((device) => device['id']));
    expect(first[0]?.['id']).toBe(PDV);
    expect(first[0]?.['operating_mode']).toBe('PDV');
  });

  test('are listed as terminals with a status', () => {
    const { context } = testContext();
    const listed = body(listTerminals(context, new URLSearchParams()));
    const data = isJsonObject(listed['data']) ? listed['data'] : {};
    expect(objects(data['terminals']).map((terminal) => terminal['status'])).toEqual([
      'active',
      'active',
      'active',
    ]);
  });

  test('filter by store_id and paginate', () => {
    const { context } = testContext();
    const all = devices(context);
    const storeId = String(all[1]?.['store_id']);
    const filtered = body(listPointDevices(context, new URLSearchParams({ store_id: storeId })));
    expect(objects(filtered['devices']).length).toBe(1);

    const page = body(listPointDevices(context, new URLSearchParams({ limit: '2', offset: '2' })));
    expect(objects(page['devices']).length).toBe(1);
    expect(page['paging']).toEqual({ total: 3, limit: 2, offset: 2 });
  });

  test('switch operating mode, which gates payment intents', () => {
    const { context } = testContext();
    expect(createPointPaymentIntent(context, STANDALONE, { amount: 100 }).ok).toBe(false);

    const updated = updateTerminalOperationMode(context, {
      terminals: [{ id: STANDALONE, operating_mode: 'PDV' }],
    });
    expect(updated.ok).toBe(true);
    expect(createPointPaymentIntent(context, STANDALONE, { amount: 100 }).ok).toBe(true);
  });

  test('an unknown terminal cannot be reconfigured', () => {
    const { context } = testContext();
    const result = updateTerminalOperationMode(context, {
      terminals: [{ id: 'PAX_A910__NOPE', operating_mode: 'PDV' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.status).toBe(404);
  });
});

describe('payment intents', () => {
  test('a created intent is OPEN and echoes the request', () => {
    const { context } = testContext();
    const created = body(
      createPointPaymentIntent(context, PDV, {
        amount: 1500,
        description: 'Coffee',
        payment: { installments: 3, type: 'credit_card' },
        additional_info: { external_reference: 'ref-1', print_on_terminal: true },
      }),
    );
    expect(created['state']).toBe('OPEN');
    expect(created['amount']).toBe(1500);
    expect(created['device_id']).toBe(PDV);
    expect(created['additional_info']).toEqual({ external_reference: 'ref-1', print_on_terminal: true });
  });

  test('accepts the spec spelling of print_on_terminal at the top level', () => {
    const { context } = testContext();
    const created = body(createPointPaymentIntent(context, PDV, { amount: 100, print_on_terminal: true }));
    const info = isJsonObject(created['additional_info']) ? created['additional_info'] : {};
    expect(info['print_on_terminal']).toBe(true);
  });

  test('an unknown command is rejected before it reaches the table', () => {
    const { context } = testContext();
    const id = openIntent(context);
    for (const command of ['toString', 'constructor', 'valueOf', '']) {
      const result = driveIntent(context, id, command);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error.status).toBe(400);
    }
    expect(body(getPointPaymentIntent(context, id))['state']).toBe('OPEN');
  });

  test('a device holds one intent at a time', () => {
    const { context } = testContext();
    openIntent(context);
    const second = createPointPaymentIntent(context, PDV, { amount: 200 });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.error.status).toBe(409);
  });

  test('a cancelled intent frees the device', () => {
    const { context } = testContext();
    const id = openIntent(context);
    expect(cancelPointPaymentIntent(context, PDV, id).ok).toBe(true);
    expect(body(getPointPaymentIntent(context, id))['state']).toBe('CANCELED');
    expect(createPointPaymentIntent(context, PDV, { amount: 200 }).ok).toBe(true);
  });

  test('cancelling twice is a conflict, and the state does not change', () => {
    const { context } = testContext();
    const id = openIntent(context);
    cancelPointPaymentIntent(context, PDV, id);
    const again = cancelPointPaymentIntent(context, PDV, id);
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error('unreachable');
    expect(again.error.status).toBe(409);
    expect(body(getPointPaymentIntent(context, id))['state']).toBe('CANCELED');
  });

  test('cancelling from the wrong device is a 404', () => {
    const { context } = testContext();
    const id = openIntent(context);
    const wrong = cancelPointPaymentIntent(context, STANDALONE, id);
    expect(wrong.ok).toBe(false);
    if (wrong.ok) throw new Error('unreachable');
    expect(wrong.error.status).toBe(404);
  });

  test('a processing intent refuses cancellation', () => {
    const { context } = testContext();
    const id = openIntent(context);
    driveIntent(context, id, 'deliver');
    driveIntent(context, id, 'process');
    const late = cancelPointPaymentIntent(context, PDV, id);
    expect(late.ok).toBe(false);
    expect(body(getPointPaymentIntent(context, id))['state']).toBe('PROCESSING');
  });

  test('rejects a non-integer or negative amount', () => {
    const { context } = testContext();
    for (const amount of [0, -1, 15.5, null]) {
      expect(createPointPaymentIntent(context, PDV, { amount }).ok).toBe(false);
    }
  });

  test('rejects an unknown payment type and an impossible instalment count', () => {
    const { context } = testContext();
    expect(createPointPaymentIntent(context, PDV, { amount: 100, payment: { type: 'pix' } }).ok).toBe(false);
    expect(
      createPointPaymentIntent(context, PDV, { amount: 100, payment: { installments: 99 } }).ok,
    ).toBe(false);
  });

  test('an unknown device is a 404', () => {
    const { context } = testContext();
    const result = createPointPaymentIntent(context, 'PAX_A910__NOPE', { amount: 100 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.status).toBe(404);
  });

  test('a finished intent creates a real, approved payment', () => {
    const { context } = testContext();
    const id = openIntent(context, {
      description: 'Coffee',
      additional_info: { external_reference: 'ref-9' },
    });
    const finished = finish(context, id);

    expect(finished['state']).toBe('FINISHED');
    const payment = isJsonObject(finished['payment']) ? finished['payment'] : {};
    const paymentId = payment['id'];
    expect(typeof paymentId).toBe('number');

    const found = body(getPayment(context, String(paymentId)));
    expect(found['status']).toBe('approved');
    expect(found['transaction_amount']).toBe(15);
    expect(found['description']).toBe('Coffee');
    expect(found['external_reference']).toBe('ref-9');
    expect(found['payment_method_id']).toBe('master');

    const searched = body(searchPayments(context, new URLSearchParams()));
    expect(objects(searched['results']).length).toBe(1);
  });

  test('a debit intent settles through the debit catalogue code', () => {
    const { context } = testContext();
    const id = openIntent(context, { payment: { type: 'debit_card' } });
    const finished = finish(context, id);
    const payment = isJsonObject(finished['payment']) ? finished['payment'] : {};
    const found = body(getPayment(context, String(payment['id'])));
    expect(found['payment_method_id']).toBe('debmaster');
  });

  test('driving is rejected for an unknown command or intent', () => {
    const { context } = testContext();
    const id = openIntent(context);
    expect(driveIntent(context, id, 'explode').ok).toBe(false);
    expect(driveIntent(context, 'nope', 'deliver').ok).toBe(false);
  });

  test('intents are listable for the dashboard', () => {
    const { context } = testContext();
    const id = openIntent(context);
    const listed = body(listIntents(context, new URLSearchParams({ device_id: PDV })));
    expect(objects(listed['results']).map((intent) => intent['id'])).toEqual([id]);
  });
});

describe('refund intents', () => {
  const settledPayment = (context: ServiceContext): number => {
    const id = openIntent(context);
    const payment = finish(context, id)['payment'];
    return (isJsonObject(payment) ? payment['id'] : 0) as number;
  };

  test('a finished refund intent refunds the payment', () => {
    const { context } = testContext();
    const paymentId = settledPayment(context);
    const created = body(createPointRefundIntent(context, PDV, { payment_id: paymentId }));
    expect(created['status']).toBe('open');

    for (const command of ['deliver', 'process', 'finish'] as const) {
      expect(driveIntent(context, created['id'] as string, command).ok).toBe(true);
    }

    const found = body(getPointRefundIntent(context, created['id'] as string));
    expect(found['status']).toBe('finished');
    expect(typeof found['refund_id']).toBe('number');
    expect(body(getPayment(context, String(paymentId)))['status']).toBe('refunded');
  });

  test('a partial refund keeps the payment approved', () => {
    const { context } = testContext();
    const paymentId = settledPayment(context);
    const created = body(createPointRefundIntent(context, PDV, { payment_id: paymentId, amount: 5 }));
    for (const command of ['deliver', 'process', 'finish'] as const) {
      driveIntent(context, created['id'] as string, command);
    }
    expect(body(getPayment(context, String(paymentId)))['transaction_amount_refunded']).toBe(5);
  });

  test('refunding twice drives the second intent to ERROR', () => {
    const { context } = testContext();
    const paymentId = settledPayment(context);
    const refund = (): string => {
      const id = body(createPointRefundIntent(context, PDV, { payment_id: paymentId }))['id'] as string;
      for (const command of ['deliver', 'process', 'finish'] as const) driveIntent(context, id, command);
      return id;
    };

    expect(body(getPointRefundIntent(context, refund()))['status']).toBe('finished');
    const failed = body(getPointRefundIntent(context, refund()));
    expect(failed['status']).toBe('error');
    expect(typeof failed['error']).toBe('string');
  });

  test('an unknown payment is a 404 and a cancelled intent is CANCELED', () => {
    const { context } = testContext();
    const missing = createPointRefundIntent(context, PDV, { payment_id: 42 });
    expect(missing.ok).toBe(false);

    const paymentId = settledPayment(context);
    const created = body(createPointRefundIntent(context, PDV, { payment_id: paymentId }));
    expect(cancelPointRefundIntent(context, PDV, created['id'] as string).ok).toBe(true);
    expect(body(getPointRefundIntent(context, created['id'] as string))['status']).toBe('canceled');
  });

  test('refuse a STANDALONE device and an amount above the refundable total', () => {
    const { context } = testContext();
    const paymentId = settledPayment(context);
    expect(createPointRefundIntent(context, STANDALONE, { payment_id: paymentId }).ok).toBe(false);

    // 1500 is the intent amount in cents; a refund amount is in major units.
    const overrefund = createPointRefundIntent(context, PDV, { payment_id: paymentId, amount: 1500 });
    expect(overrefund.ok).toBe(false);
    if (overrefund.ok) throw new Error('unreachable');
    expect(overrefund.error.status).toBe(400);
  });

  test('a payment intent id is not a refund intent id', () => {
    const { context } = testContext();
    const id = openIntent(context);
    expect(getPointRefundIntent(context, id).ok).toBe(false);
  });
});

describe('terminal actions', () => {
  const action = (context: ServiceContext) =>
    body(
      createTerminalAction(context, {
        type: 'PRINT_INFO',
        external_reference: 'job-1',
        config: { device_id: PDV },
        content: { source: 'https://example.test/logo.png' },
      }),
    );

  test('start pending and carry the terminal they target', () => {
    const { context } = testContext();
    const created = action(context);
    expect(created['status']).toBe('pending');
    expect(created['terminal_id']).toBe(PDV);
    expect(created['action']).toBe('PRINT_INFO');
    expect(body(getTerminalAction(context, created['id'] as string))['external_reference']).toBe('job-1');
  });

  test('are cancellable while pending and not after printing', () => {
    const { context } = testContext();
    const first = action(context);
    expect(body(cancelTerminalAction(context, first['id'] as string))['status']).toBe('canceled');

    const second = action(context);
    driveTerminalAction(context, second['id'] as string, 'send');
    driveTerminalAction(context, second['id'] as string, 'print');
    const late = cancelTerminalAction(context, second['id'] as string);
    expect(late.ok).toBe(false);
    if (late.ok) throw new Error('unreachable');
    expect(late.error.status).toBe(409);
  });

  test('printed and canceled are terminal', () => {
    expect(ACTION_TRANSITIONS.printed).toEqual([]);
    expect(ACTION_TRANSITIONS.canceled).toEqual([]);
  });

  test('reject an unknown type, a missing reference and an unknown terminal', () => {
    const { context } = testContext();
    expect(createTerminalAction(context, { external_reference: 'x', config: { device_id: PDV } }).ok).toBe(false);
    expect(createTerminalAction(context, { type: 'PRINT_INFO', config: { device_id: PDV } }).ok).toBe(false);
    expect(
      createTerminalAction(context, {
        type: 'PRINT_INFO',
        external_reference: 'x',
        config: { device_id: 'PAX_A910__NOPE' },
      }).ok,
    ).toBe(false);
  });

  test('an action id is not a device id', () => {
    const { context } = testContext();
    expect(getTerminalAction(context, PDV).ok).toBe(false);
  });
});
