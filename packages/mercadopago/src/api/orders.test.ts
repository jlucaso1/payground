import { describe, expect, test } from 'bun:test';
import type { JsonObject, JsonValue, Result } from '@payground/core';
import { SeededRandom } from '@payground/core/testing.ts';
import type { ErrorBody } from '../errors.ts';
import { ORDER_TRANSACTION_STATUSES } from '../generated/tables.ts';
import { createCardToken } from './card-tokens.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { type Harness, cardTokenBody, harness } from './fixture.ts';
import {
  type OrderState,
  addTransaction,
  cancelOrder,
  captureOrder,
  createOrder,
  deleteTransaction,
  deriveStatus,
  getOrder,
  processOrder,
  refundOrder,
  searchOrders,
  updateTransaction,
} from './orders.ts';

type Call = Result<Rendered, ErrorBody>;

function rendered(result: Call): Rendered {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function failure(result: Call): ErrorBody {
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result.value)}`);
  return result.error;
}

const order = (result: Call): JsonObject => rendered(result).body as JsonObject;

const transactions = (body: JsonObject): JsonObject[] =>
  ((body['transactions'] as JsonObject)['payments'] as JsonObject[]) ?? [];

const refunds = (body: JsonObject): JsonObject[] =>
  ((body['transactions'] as JsonObject)['refunds'] as JsonObject[]) ?? [];

const first = (body: JsonObject): JsonObject => {
  const payment = transactions(body)[0];
  if (payment === undefined) throw new Error('no transaction');
  return payment;
};

const state = (value: JsonObject): [JsonValue | undefined, JsonValue | undefined] => [value['status'], value['status_detail']];

const PAIRS = new Set(ORDER_TRANSACTION_STATUSES.map((entry) => `${entry.status}/${entry.detail}`));

const payer = { email: 'payer@example.com', identification: { type: 'CPF', number: '12345678909' } };

const pixBody = (overrides: Record<string, unknown> = {}) => ({
  type: 'online',
  total_amount: '100.00',
  payer,
  transactions: {
    payments: [{ amount: '100.00', payment_method: { id: 'pix', type: 'bank_transfer' } }],
  },
  ...overrides,
});

function token(context: ServiceContext, name = 'APRO'): string {
  const created = rendered(
    createCardToken(context, cardTokenBody({ cardholder: { name, identification: { type: 'CPF', number: '12345678909' } } })),
  );
  return (created.body as JsonObject)['id'] as string;
}

const cardBody = (context: ServiceContext, name = 'APRO', overrides: Record<string, unknown> = {}) => ({
  type: 'online',
  total_amount: '100.00',
  payer,
  transactions: {
    payments: [
      {
        amount: '100.00',
        payment_method: { id: 'master', type: 'credit_card', token: token(context, name), installments: 1 },
      },
    ],
  },
  ...overrides,
});

interface Recorded {
  action: string;
  dataId: string;
}

function recording(): { harness: Harness; events: Recorded[] } {
  const events: Recorded[] = [];
  const created = harness();
  const context: ServiceContext = {
    ...created.context,
    events: { emit: (notice) => events.push({ action: notice.action, dataId: notice.dataId }) },
  };
  return { harness: { ...created, context }, events };
}

describe('orders — creation', () => {
  test('an automatic pix order settles into action_required on creation', () => {
    const { context } = harness();
    const body = order(createOrder(context, pixBody()));

    expect(body['id']).toMatch(/^ORD[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(state(body)).toEqual(['action_required', 'waiting_transfer']);
    expect(state(first(body))).toEqual(['action_required', 'waiting_transfer']);
    expect(body['total_amount']).toBe('100.00');
    expect(body['total_paid_amount']).toBe('0.00');
    expect(body['processing_mode']).toBe('automatic');
    expect(first(body)['id']).toMatch(/^PAY[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(first(body)['date_of_expiration']).toBeString();
  });

  test('a pix transaction carries the BR Code artifacts', () => {
    const { context } = harness();
    const method = first(order(createOrder(context, pixBody())))['payment_method'] as JsonObject;
    expect(method['qr_code']).toContain('br.gov.bcb.pix');
    expect(method['qr_code_base64']).toBeString();
    expect(method['ticket_url']).toContain('/orders/ORD');
  });

  test('a manual order waits for an explicit process call', () => {
    const { context } = harness();
    const body = order(createOrder(context, pixBody({ processing_mode: 'manual' })));
    expect(state(body)).toEqual(['created', 'created']);
    expect(state(first(body))).toEqual(['created', 'created']);

    const processed = order(processOrder(context, body['id'] as string, undefined));
    expect(state(processed)).toEqual(['action_required', 'waiting_transfer']);
  });

  test('processing an already processed order conflicts', () => {
    const { context } = harness();
    const id = order(createOrder(context, pixBody({ processing_mode: 'manual' })))['id'] as string;
    processOrder(context, id, undefined);
    expect(failure(processOrder(context, id, undefined)).status).toBe(409);
  });

  test('an automatic order cannot be processed by hand', () => {
    const { context } = harness();
    const id = order(createOrder(context, pixBody()))['id'] as string;
    expect(failure(processOrder(context, id, undefined)).status).toBe(409);
  });

  test('a ticket order waits for the payer instead of the transfer', () => {
    const { context } = harness();
    const body = order(
      createOrder(
        context,
        pixBody({
          transactions: {
            payments: [{ amount: '100.00', payment_method: { id: 'bolbradesco', type: 'ticket' } }],
          },
        }),
      ),
    );
    expect(state(first(body))).toEqual(['action_required', 'waiting_payment']);
    expect((first(body)['payment_method'] as JsonObject)['ticket_url']).toContain('/orders/ORD');
  });

  test('account money settles straight away', () => {
    const { context } = harness();
    const body = order(
      createOrder(
        context,
        pixBody({
          transactions: {
            payments: [{ amount: '100.00', payment_method: { id: 'account_money', type: 'account_money' } }],
          },
        }),
      ),
    );
    expect(state(body)).toEqual(['processed', 'accredited']);
    expect(body['total_paid_amount']).toBe('100.00');
  });

  test('an event is emitted for creation and for every later change', () => {
    const { harness: created, events } = recording();
    const id = order(createOrder(created.context, pixBody({ processing_mode: 'manual' })))['id'] as string;
    processOrder(created.context, id, undefined);
    cancelOrder(created.context, id, undefined);

    expect(events.map((event) => event.action)).toEqual(['order.created', 'order.updated', 'order.updated']);
    expect(new Set(events.map((event) => event.dataId))).toEqual(new Set([id]));
  });
});

describe('orders — validation', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['a missing type', { total_amount: '10.00', payer, transactions: { payments: [] } }],
    ['a non-decimal total', pixBody({ total_amount: '100,00' })],
    ['a zero total', pixBody({ total_amount: '0', transactions: { payments: [] } })],
    ['no payments', pixBody({ transactions: { payments: [] } })],
    [
      'a sum that does not match the total',
      pixBody({ transactions: { payments: [{ amount: '99.00', payment_method: { id: 'pix', type: 'bank_transfer' } }] } }),
    ],
    [
      'a card without a token',
      pixBody({ transactions: { payments: [{ amount: '100.00', payment_method: { id: 'master', type: 'credit_card' } }] } }),
    ],
    [
      'an unknown method type',
      pixBody({ transactions: { payments: [{ amount: '100.00', payment_method: { id: 'x', type: 'crypto' } }] } }),
    ],
    [
      'an invalid expiration_time',
      pixBody({
        transactions: {
          payments: [{ amount: '100.00', expiration_time: '30 minutes', payment_method: { id: 'pix', type: 'bank_transfer' } }],
        },
      }),
    ],
    [
      'too many installments',
      pixBody({
        transactions: {
          payments: [
            { amount: '100.00', payment_method: { id: 'master', type: 'credit_card', token: 'tok', installments: 99 } },
          ],
        },
      }),
    ],
  ];

  for (const [name, body] of cases) {
    test(`rejects ${name}`, () => {
      const { context } = harness();
      const error = failure(createOrder(context, body));
      expect(error.status).toBe(400);
      expect(error.cause.length).toBeGreaterThan(0);
    });
  }

  test('an unknown order is a 404', () => {
    const { context } = harness();
    expect(failure(getOrder(context, 'ORD404')).status).toBe(404);
  });

  test('expiration_time sets the deadline', () => {
    const { clock, context } = harness();
    const body = order(
      createOrder(
        context,
        pixBody({
          transactions: {
            payments: [{ amount: '100.00', expiration_time: 'PT30M', payment_method: { id: 'pix', type: 'bank_transfer' } }],
          },
        }),
      ),
    );
    const deadline = Date.parse(first(body)['date_of_expiration'] as string);
    expect(deadline - clock.now()).toBe(30 * 60_000);
  });
});

describe('orders — card processing', () => {
  test('an approved card settles on creation', () => {
    const { context } = harness();
    const body = order(createOrder(context, cardBody(context)));
    expect(state(body)).toEqual(['processed', 'accredited']);
    expect(first(body)['paid_amount']).toBe('100.00');
  });

  test('a contingency card is left in processing', () => {
    const { context } = harness();
    const body = order(createOrder(context, cardBody(context, 'CONT')));
    expect(state(body)).toEqual(['processing', 'in_process']);
  });

  test('every declining cardholder maps to a documented failure detail', () => {
    const declines: Record<string, string> = {
      OTHE: 'processing_error',
      CALL: 'required_call_for_authorize',
      FUND: 'card_insufficient_amount',
      SECU: 'bad_filled_card_data',
      EXPI: 'bad_filled_card_data',
      FORM: 'bad_filled_card_data',
      CARD: 'bad_filled_card_data',
      INST: 'invalid_installments',
      DUPL: 'rejected_by_issuer',
      LOCK: 'card_disabled',
      CTNA: 'rejected_by_issuer',
      ATTE: 'max_attempts_exceeded',
      BLAC: 'high_risk',
      UNSU: 'processing_error',
    };

    for (const [name, detail] of Object.entries(declines)) {
      const { context } = harness();
      const body = order(createOrder(context, cardBody(context, name)));
      expect(state(body)).toEqual(['failed', detail]);
      expect(PAIRS.has(`failed/${detail}`)).toBe(true);
    }
  });

  test('an unusable card token fails the transaction rather than the request', () => {
    const { context } = harness();
    const body = order(
      createOrder(
        context,
        pixBody({
          transactions: {
            payments: [{ amount: '100.00', payment_method: { id: 'master', type: 'credit_card', token: 'gone' } }],
          },
        }),
      ),
    );
    expect(state(body)).toEqual(['failed', 'invalid_card_token']);
  });

  test('manual capture authorizes and waits', () => {
    const { context } = harness();
    const body = order(createOrder(context, cardBody(context, 'APRO', { capture_mode: 'manual' })));
    expect(state(body)).toEqual(['action_required', 'waiting_capture']);
    expect(body['total_paid_amount']).toBe('0.00');
  });

  test('a full capture settles the authorized amount', () => {
    const { context } = harness();
    const id = order(createOrder(context, cardBody(context, 'APRO', { capture_mode: 'manual' })))['id'] as string;
    const captured = order(captureOrder(context, id, undefined));
    expect(state(captured)).toEqual(['processed', 'accredited']);
    expect(captured['total_paid_amount']).toBe('100.00');
  });

  test('a partial capture settles only what was captured', () => {
    const { context } = harness();
    const created = order(createOrder(context, cardBody(context, 'APRO', { capture_mode: 'manual' })));
    const id = created['id'] as string;
    const captured = order(
      captureOrder(context, id, { transactions: { payments: [{ id: first(created)['id'], amount: '40.00' }] } }),
    );
    expect(state(captured)).toEqual(['processed', 'accredited']);
    expect(first(captured)['paid_amount']).toBe('40.00');
    expect(first(captured)['amount']).toBe('100.00');
    expect(captured['total_paid_amount']).toBe('40.00');
  });

  test('capture is rejected above the authorized amount, on the wrong mode, and twice', () => {
    const { context } = harness();
    const created = order(createOrder(context, cardBody(context, 'APRO', { capture_mode: 'manual' })));
    const id = created['id'] as string;
    expect(
      failure(captureOrder(context, id, { transactions: { payments: [{ id: first(created)['id'], amount: '200.00' }] } })).status,
    ).toBe(400);
    expect(failure(captureOrder(context, id, { transactions: { payments: [{ id: 'PAYnope' }] } })).status).toBe(404);
    captureOrder(context, id, undefined);
    expect(failure(captureOrder(context, id, undefined)).status).toBe(409);

    const automatic = order(createOrder(context, cardBody(context)))['id'] as string;
    expect(failure(captureOrder(context, automatic, undefined)).status).toBe(409);
  });
});

describe('orders — refund and cancel', () => {
  const settled = (context: ServiceContext): JsonObject => order(createOrder(context, cardBody(context)));

  test('a full refund moves the transaction and the order to refunded', () => {
    const { context } = harness();
    const id = settled(context)['id'] as string;
    const result = refundOrder(context, id, undefined);
    expect(rendered(result).status).toBe(201);

    const body = order(result);
    expect(state(body)).toEqual(['refunded', 'refunded']);
    expect(state(first(body))).toEqual(['refunded', 'refunded']);
    expect(refunds(body)).toHaveLength(1);
    expect(refunds(body)[0]?.['amount']).toBe('100.00');
    expect(refunds(body)[0]?.['id']).toMatch(/^REF/);
  });

  test('a partial refund leaves the transaction processed and partially refunded', () => {
    const { context } = harness();
    const created = settled(context);
    const id = created['id'] as string;
    const body = order(refundOrder(context, id, { transactions: [{ id: first(created)['id'], amount: '30.00' }] }));

    expect(state(body)).toEqual(['processed', 'partially_refunded']);
    expect(state(first(body))).toEqual(['processed', 'partially_refunded']);

    const rest = order(refundOrder(context, id, { transactions: [{ id: first(created)['id'], amount: '70.00' }] }));
    expect(state(rest)).toEqual(['refunded', 'refunded']);
    expect(refunds(rest)).toHaveLength(2);
  });

  test('a refund cannot exceed what is left, or target an unknown transaction', () => {
    const { context } = harness();
    const created = settled(context);
    const id = created['id'] as string;
    expect(failure(refundOrder(context, id, { transactions: [{ id: first(created)['id'], amount: '101.00' }] })).status).toBe(400);
    expect(failure(refundOrder(context, id, { transactions: [{ id: 'PAYnope', amount: '1.00' }] })).status).toBe(404);

    refundOrder(context, id, undefined);
    expect(failure(refundOrder(context, id, undefined)).status).toBe(409);
  });

  test('an unpaid order cannot be refunded', () => {
    const { context } = harness();
    const id = order(createOrder(context, pixBody()))['id'] as string;
    expect(failure(refundOrder(context, id, undefined)).status).toBe(409);
  });

  test('cancelling a waiting order cancels its transactions', () => {
    const { context } = harness();
    const id = order(createOrder(context, pixBody()))['id'] as string;
    const body = order(cancelOrder(context, id, undefined));
    expect(state(body)).toEqual(['canceled', 'canceled']);
    expect(state(first(body))).toEqual(['canceled', 'canceled']);
    expect(failure(cancelOrder(context, id, undefined)).status).toBe(409);
  });

  test('a processed order cannot be cancelled', () => {
    const { context } = harness();
    const id = settled(context)['id'] as string;
    expect(failure(cancelOrder(context, id, undefined)).status).toBe(409);
  });
});

describe('orders — expiry', () => {
  test('a pix transaction expires on read', () => {
    const { clock, context } = harness();
    const id = order(createOrder(context, pixBody()))['id'] as string;

    clock.advance(24 * 60 * 60 * 1000);
    const body = order(getOrder(context, id));
    expect(state(body)).toEqual(['expired', 'expired']);
    expect(state(first(body))).toEqual(['expired', 'expired']);

    // The expiry is persisted, not recomputed on every read.
    const stored = context.store.documents.get('order', id);
    expect(stored?.status).toBe('expired');
  });

  test('an expired order cannot be captured or cancelled', () => {
    const { clock, context } = harness();
    const id = order(createOrder(context, pixBody()))['id'] as string;
    clock.advance(24 * 60 * 60 * 1000);
    expect(failure(cancelOrder(context, id, undefined)).status).toBe(409);
    expect(failure(captureOrder(context, id, undefined)).status).toBe(409);
  });
});

describe('orders — transactions', () => {
  const manual = (context: ServiceContext): JsonObject =>
    order(
      createOrder(
        context,
        pixBody({
          processing_mode: 'manual',
          total_amount: '150.00',
          transactions: { payments: [{ amount: '100.00', payment_method: { id: 'pix', type: 'bank_transfer' } }] },
        }),
      ),
    );

  test('a transaction can be added while the order is in created', () => {
    const { context } = harness();
    const id = manual(context)['id'] as string;
    const result = addTransaction(context, id, {
      amount: '50.00',
      payment_method: { id: 'account_money', type: 'account_money' },
    });
    expect(rendered(result).status).toBe(201);
    expect((rendered(result).body as JsonObject)['id']).toMatch(/^PAY/);

    const body = order(getOrder(context, id));
    expect(transactions(body)).toHaveLength(2);
    expect(state(body)).toEqual(['created', 'created']);
  });

  test('the wrapped form returns the created payments', () => {
    const { context } = harness();
    const id = manual(context)['id'] as string;
    const result = rendered(
      addTransaction(context, id, {
        payments: [{ amount: '50.00', payment_method: { id: 'account_money', type: 'account_money' } }],
      }),
    );
    expect(((result.body as JsonObject)['payments'] as JsonObject[])).toHaveLength(1);
  });

  test('a transaction cannot push the order over total_amount', () => {
    const { context } = harness();
    const id = manual(context)['id'] as string;
    const error = failure(
      addTransaction(context, id, { amount: '80.00', payment_method: { id: 'pix', type: 'bank_transfer' } }),
    );
    expect(error.status).toBe(422);
  });

  test('a transaction cannot be added once the order has been processed', () => {
    const { context } = harness();
    const created = order(createOrder(context, pixBody()));
    const error = failure(
      addTransaction(context, created['id'] as string, {
        amount: '10.00',
        payment_method: { id: 'pix', type: 'bank_transfer' },
      }),
    );
    expect(error.status).toBe(422);
  });

  test('a created transaction can be updated and deleted', () => {
    const { context } = harness();
    const created = manual(context);
    const id = created['id'] as string;
    const transactionId = first(created)['id'] as string;

    const updated = rendered(updateTransaction(context, id, transactionId, { amount: '150.00' }));
    expect((updated.body as JsonObject)['amount']).toBe('150.00');

    const deleted = rendered(deleteTransaction(context, id, transactionId));
    expect(deleted.status).toBe(204);
    expect(deleted.body).toBeUndefined();
    expect(transactions(order(getOrder(context, id)))).toHaveLength(0);
    expect(state(order(getOrder(context, id)))).toEqual(['created', 'created']);
  });

  test('a processed transaction can no longer be updated or deleted', () => {
    const { context } = harness();
    const created = order(createOrder(context, pixBody()));
    const id = created['id'] as string;
    const transactionId = first(created)['id'] as string;
    expect(failure(updateTransaction(context, id, transactionId, { amount: '10.00' })).status).toBe(422);
    expect(failure(deleteTransaction(context, id, transactionId)).status).toBe(422);
  });

  test('an underfunded order cannot be processed', () => {
    const { context } = harness();
    const id = manual(context)['id'] as string;
    expect(failure(processOrder(context, id, undefined)).status).toBe(409);
  });

  test('unknown transactions are 404s and bad patches are 400s', () => {
    const { context } = harness();
    const created = manual(context);
    const id = created['id'] as string;
    expect(failure(updateTransaction(context, id, 'PAYnope', { amount: '1.00' })).status).toBe(404);
    expect(failure(deleteTransaction(context, id, 'PAYnope')).status).toBe(404);
    expect(failure(updateTransaction(context, id, first(created)['id'] as string, { amount: 10 })).status).toBe(400);
    expect(failure(updateTransaction(context, id, first(created)['id'] as string, { amount: '200.00' })).status).toBe(422);
    expect(failure(addTransaction(context, id, { amount: '1.00' })).status).toBe(400);
  });

  test('switching a transaction to a card demands a token', () => {
    const { context } = harness();
    const created = manual(context);
    const id = created['id'] as string;
    const transactionId = first(created)['id'] as string;
    expect(
      failure(updateTransaction(context, id, transactionId, { payment_method: { type: 'credit_card' } })).status,
    ).toBe(400);

    const updated = rendered(
      updateTransaction(context, id, transactionId, {
        amount: '150.00',
        payment_method: { id: 'master', type: 'credit_card', token: token(context), installments: 3 },
      }),
    );
    const method = (updated.body as JsonObject)['payment_method'] as JsonObject;
    expect(method['installments']).toBe(3);

    const processed = order(processOrder(context, id, undefined));
    expect(state(processed)).toEqual(['processed', 'accredited']);
  });
});

describe('orders — search', () => {
  test('filters by external reference, status and date window, and pages', () => {
    const { clock, context } = harness();
    const start = clock.now();
    order(createOrder(context, pixBody({ external_reference: 'a' })));
    clock.advance(1_000);
    order(createOrder(context, pixBody({ external_reference: 'b' })));
    clock.advance(1_000);
    order(createOrder(context, cardBody(context, 'APRO', { external_reference: 'b' })));

    const all = rendered(searchOrders(context, new URLSearchParams())).body as JsonObject;
    expect((all['paging'] as JsonObject)['total']).toBe(3);
    expect((all['data'] as JsonObject[]).length).toBe(3);

    const byReference = rendered(searchOrders(context, new URLSearchParams({ external_reference: 'b' })))
      .body as JsonObject;
    expect((byReference['paging'] as JsonObject)['total']).toBe(2);

    const byStatus = rendered(searchOrders(context, new URLSearchParams({ status: 'processed' }))).body as JsonObject;
    expect((byStatus['data'] as JsonObject[])).toHaveLength(1);

    const window = rendered(
      searchOrders(
        context,
        new URLSearchParams({
          begin_date: new Date(start + 1_000).toISOString(),
          end_date: new Date(start + 1_000).toISOString(),
        }),
      ),
    ).body as JsonObject;
    expect((window['paging'] as JsonObject)['total']).toBe(1);

    const paged = rendered(searchOrders(context, new URLSearchParams({ limit: '1', offset: '2' }))).body as JsonObject;
    expect((paged['data'] as JsonObject[])).toHaveLength(1);
    expect((paged['paging'] as JsonObject)).toEqual({ total: 3, limit: 1, offset: 2 });
  });

  test('rejects a malformed window or page', () => {
    const { context } = harness();
    expect(failure(searchOrders(context, new URLSearchParams({ begin_date: 'yesterday' }))).status).toBe(400);
    expect(failure(searchOrders(context, new URLSearchParams({ limit: '-1' }))).status).toBe(400);
  });

  test('search results expire on read like a get does', () => {
    const { clock, context } = harness();
    order(createOrder(context, pixBody()));
    clock.advance(24 * 60 * 60 * 1000);
    const found = rendered(searchOrders(context, new URLSearchParams())).body as JsonObject;
    expect((found['data'] as JsonObject[])[0]?.['status']).toBe('expired');
  });
});

describe('orders — derived status', () => {
  const derived = (...states: OrderState[]): [string, string] => {
    const result = deriveStatus(states);
    return [result.status, result.detail];
  };

  test('an order with no transaction is created', () => {
    expect(derived()).toEqual(['created', 'created']);
  });

  test('the first transaction still in flight decides the order', () => {
    expect(derived({ status: 'processed', detail: 'accredited' }, { status: 'created', detail: 'created' })).toEqual([
      'created',
      'created',
    ]);
    expect(
      derived({ status: 'action_required', detail: 'waiting_capture' }, { status: 'failed', detail: 'high_risk' }),
    ).toEqual(['action_required', 'waiting_capture']);
  });

  test('terminal transactions fold together', () => {
    expect(derived({ status: 'processed', detail: 'accredited' })).toEqual(['processed', 'accredited']);
    expect(derived({ status: 'refunded', detail: 'refunded' })).toEqual(['refunded', 'refunded']);
    expect(
      derived({ status: 'refunded', detail: 'refunded' }, { status: 'processed', detail: 'accredited' }),
    ).toEqual(['processed', 'partially_refunded']);
    expect(derived({ status: 'failed', detail: 'card_disabled' })).toEqual(['failed', 'card_disabled']);
    expect(derived({ status: 'expired', detail: 'expired' })).toEqual(['expired', 'expired']);
    expect(derived({ status: 'charged_back', detail: 'in_process' })).toEqual(['charged_back', 'in_process']);
  });

  test('cancelled transactions are ignored unless they are all cancelled', () => {
    expect(derived({ status: 'canceled', detail: 'canceled' })).toEqual(['canceled', 'canceled']);
    expect(
      derived({ status: 'canceled', detail: 'canceled' }, { status: 'processed', detail: 'accredited' }),
    ).toEqual(['processed', 'accredited']);
  });

  test('the derivation stays consistent over random transaction sets', () => {
    const random = new SeededRandom(7);
    const vocabulary = ORDER_TRANSACTION_STATUSES.filter((entry) => entry.status !== 'processing' || true);
    const terminal = ['processed', 'refunded', 'failed', 'expired', 'canceled', 'charged_back'];

    for (let round = 0; round < 2_000; round++) {
      const states: OrderState[] = [];
      for (let index = 0; index < random.int(4); index++) {
        const entry = vocabulary[random.int(vocabulary.length)];
        if (entry === undefined) continue;
        states.push({ status: entry.status as OrderState['status'], detail: entry.detail });
      }

      const result = deriveStatus(states);
      expect(PAIRS.has(`${result.status}/${result.detail}`)).toBe(true);

      const active = states.filter((entry) => entry.status !== 'canceled');
      if (states.length === 0 || active.length === 0) continue;

      if (terminal.includes(result.status)) {
        expect(active.every((entry) => terminal.includes(entry.status))).toBe(true);
      } else {
        expect(active.some((entry) => entry.status === result.status && entry.detail === result.detail)).toBe(true);
      }
    }
  });
});

describe('orders — fuzz over random order shapes', () => {
  const METHODS = [
    { id: 'pix', type: 'bank_transfer' },
    { id: 'bolbradesco', type: 'ticket' },
    { id: 'account_money', type: 'account_money' },
    { id: 'master', type: 'credit_card' },
  ] as const;

  const HOLDERS = ['APRO', 'FUND', 'CONT', 'OTHE'] as const;

  test('the order status always matches its transactions, whatever happens to it', () => {
    const random = new SeededRandom(42);

    for (let round = 0; round < 120; round++) {
      const { clock, context } = harness();
      const count = 1 + random.int(3);
      const amounts: string[] = [];
      const payments: Record<string, unknown>[] = [];

      for (let index = 0; index < count; index++) {
        const method = METHODS[random.int(METHODS.length)] ?? METHODS[0];
        const amount = `${10 + random.int(90)}.00`;
        amounts.push(amount);
        payments.push({
          amount,
          payment_method:
            method.type === 'credit_card'
              ? { ...method, token: token(context, HOLDERS[random.int(HOLDERS.length)] ?? 'APRO'), installments: 1 }
              : { ...method },
        });
      }

      const sum = amounts.reduce((carry, amount) => carry + Math.round(Number(amount) * 100), 0);
      const created = createOrder(context, {
        type: 'online',
        total_amount: (sum / 100).toFixed(2),
        processing_mode: random.int(2) === 0 ? 'manual' : 'automatic',
        capture_mode: random.int(2) === 0 ? 'manual' : 'automatic',
        payer,
        transactions: { payments },
      });
      if (!created.ok) throw new Error(JSON.stringify(created.error));
      const id = (created.value.body as JsonObject)['id'] as string;

      const operations = [
        () => processOrder(context, id, undefined),
        () => captureOrder(context, id, undefined),
        () => refundOrder(context, id, undefined),
        () => cancelOrder(context, id, undefined),
        () => {
          clock.advance(random.int(2) === 0 ? 1_000 : 30 * 24 * 60 * 60 * 1000);
          return getOrder(context, id);
        },
      ];

      for (let step = 0; step < 4; step++) {
        const operation = operations[random.int(operations.length)];
        operation?.();
      }

      const body = order(getOrder(context, id));
      const states = transactions(body).map((payment) => ({
        status: payment['status'] as OrderState['status'],
        detail: payment['status_detail'] as string,
      }));
      const expected = deriveStatus(states);

      expect(state(body)).toEqual([expected.status, expected.detail]);
      expect(PAIRS.has(`${body['status'] as string}/${body['status_detail'] as string}`)).toBe(true);
      for (const payment of transactions(body)) {
        expect(PAIRS.has(`${payment['status'] as string}/${payment['status_detail'] as string}`)).toBe(true);
      }
      expect(Number(body['total_paid_amount'])).toBeLessThanOrEqual(Number(body['total_amount']));
      expect(context.store.documents.get('order', id)?.status).toBe(body['status'] as string);
    }
  });
});
