import { describe, expect, test } from 'bun:test';
import type { JsonObject, Result } from '@payground/core';
import type { ErrorBody } from '../errors.ts';
import type { Rendered } from './context.ts';
import { harness } from './fixture.ts';
import {
  cancelPayoutTransaction,
  createPayout,
  deriveStatus,
  getTransactionIntent,
  listPayoutTransactions,
  processTransactionIntent,
} from './payouts.ts';

type Call = Result<Rendered, ErrorBody>;

function rendered(result: Call): Rendered {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function failure(result: Call): ErrorBody {
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result.value)}`);
  return result.error;
}

const payout = (result: Call): JsonObject => rendered(result).body as JsonObject;

const transactions = (body: JsonObject): JsonObject[] => (body['transactions'] as JsonObject[]) ?? [];

const pix = (key: string, amount: number) => ({ amount, receiver: { pix_key: key } });

const account = (amount: number) => ({
  amount,
  receiver: { bank_code: '237', branch: '0001', account: '12345-6', document: '12345678909' },
});

const batch = (entries: unknown[], total: number) => ({
  external_reference: 'P1',
  currency_id: 'BRL',
  total_amount: total,
  transactions: entries,
});

describe('deriveStatus', () => {
  test('a pending transfer keeps the whole batch pending', () => {
    expect(
      deriveStatus([
        { status: 'processed', detail: 'accredited' },
        { status: 'pending', detail: 'pending_transfer' },
      ]),
    ).toEqual({ status: 'pending', detail: 'pending_transfer' });
  });

  test('folds terminal outcomes together', () => {
    expect(deriveStatus([{ status: 'processed', detail: 'accredited' }])).toEqual({
      status: 'processed',
      detail: 'accredited',
    });
    expect(
      deriveStatus([
        { status: 'processed', detail: 'accredited' },
        { status: 'failed', detail: 'invalid_pix_key' },
      ]).status,
    ).toBe('partially_processed');
    expect(
      deriveStatus([
        { status: 'cancelled', detail: 'cancelled_by_collector' },
        { status: 'failed', detail: 'invalid_pix_key' },
      ]).status,
    ).toBe('failed');
    expect(deriveStatus([{ status: 'cancelled', detail: 'cancelled_by_collector' }]).status).toBe('cancelled');
    expect(deriveStatus([]).status).toBe('pending');
  });
});

describe('createPayout', () => {
  test('settles a Pix batch and derives the batch status', () => {
    const app = harness();
    const body = payout(createPayout(app.context, batch([pix('a@b.c', 10), pix('c@d.e', 20)], 30)));

    expect(body['status']).toBe('processed');
    expect(body['total_amount']).toBe(30);
    expect(body['external_reference']).toBe('P1');
    expect(transactions(body).map((entry) => entry['status'])).toEqual(['processed', 'processed']);
  });

  test('a TED stays pending, so the batch does too', () => {
    const app = harness();
    const body = payout(createPayout(app.context, batch([pix('a@b.c', 10), account(20)], 30)));
    expect(body['status']).toBe('pending');
  });

  test('an unusable Pix key fails its transfer and leaves the batch partially processed', () => {
    const app = harness();
    const body = payout(createPayout(app.context, batch([pix('a@b.c', 10), pix('not a key', 20)], 30)));
    expect(body['status']).toBe('partially_processed');
    expect(transactions(body)[1]).toMatchObject({ status: 'failed', status_detail: 'invalid_pix_key' });
  });

  test('rejects a total that does not match the transactions', () => {
    const app = harness();
    const error = failure(createPayout(app.context, batch([pix('a@b.c', 10), pix('c@d.e', 20)], 31)));
    expect(error.status).toBe(400);
    expect(error.cause[0]?.description).toContain('total_amount');
  });

  test('sums in minor units, so cents never drift', () => {
    const app = harness();
    const body = payout(
      createPayout(app.context, batch([pix('a@b.c', 0.1), pix('c@d.e', 0.2)], 0.3)),
    );
    expect(body['status']).toBe('processed');
    expect(body['total_amount']).toBe(0.3);
  });

  test('rejects malformed batches', () => {
    const app = harness();
    expect(failure(createPayout(app.context, 'nope')).status).toBe(400);
    expect(failure(createPayout(app.context, batch([], 10))).status).toBe(400);
    expect(failure(createPayout(app.context, batch([pix('a@b.c', 0)], 10))).status).toBe(400);
    expect(failure(createPayout(app.context, batch([{ amount: 10 }], 10))).status).toBe(400);
    expect(
      failure(createPayout(app.context, { ...batch([pix('a@b.c', 10)], 10), currency_id: 'ARS' })).status,
    ).toBe(400);
    expect(
      failure(createPayout(app.context, batch([{ amount: 10, receiver: { bank_code: '237' } }], 10))).cause[0]
        ?.description,
    ).toContain('branch');
  });
});

describe('payout transactions', () => {
  test('lists the transactions with paging and a status filter', () => {
    const app = harness();
    const body = payout(createPayout(app.context, batch([pix('a@b.c', 10), account(20)], 30)));
    const id = body['id'] as string;

    const all = rendered(listPayoutTransactions(app.context, id, new URLSearchParams())).body as JsonObject;
    expect((all['results'] as JsonObject[]).length).toBe(2);
    expect(all['paging']).toEqual({ total: 2, limit: 30, offset: 0 });

    const pendingOnly = rendered(
      listPayoutTransactions(app.context, id, new URLSearchParams({ status: 'pending' })),
    ).body as JsonObject;
    expect((pendingOnly['results'] as JsonObject[]).length).toBe(1);

    expect(failure(listPayoutTransactions(app.context, 'missing', new URLSearchParams())).status).toBe(404);
    expect(failure(listPayoutTransactions(app.context, id, new URLSearchParams({ limit: '-1' }))).status).toBe(
      400,
    );
  });

  test('cancels a pending transfer and refuses a processed one', () => {
    const app = harness();
    const body = payout(createPayout(app.context, batch([pix('a@b.c', 10), account(20)], 30)));
    const id = body['id'] as string;
    const [settled, pending] = transactions(body);

    const cancelled = rendered(
      cancelPayoutTransaction(app.context, id, pending?.['id'] as string),
    ).body as JsonObject;
    expect(cancelled).toMatchObject({ status: 'cancelled', status_detail: 'cancelled_by_collector' });

    const after = rendered(listPayoutTransactions(app.context, id, new URLSearchParams()));
    expect((after.body as JsonObject)['paging']).toEqual({ total: 2, limit: 30, offset: 0 });

    const refused = failure(cancelPayoutTransaction(app.context, id, settled?.['id'] as string));
    expect(refused.status).toBe(409);
    expect(refused.cause[0]).toEqual({ code: 4051, description: 'a transaction in status processed cannot be cancelled' });

    expect(failure(cancelPayoutTransaction(app.context, id, 'missing')).status).toBe(404);
    expect(failure(cancelPayoutTransaction(app.context, 'missing', 'x')).status).toBe(404);
  });

  test('a pending TED settles once its release date passes', () => {
    const app = harness();
    const created = payout(createPayout(app.context, batch([account(20)], 20)));
    const id = created['id'] as string;
    expect(created['status']).toBe('pending');
    expect(transactions(created)[0]?.['money_release_date']).toBeString();

    app.clock.advance(24 * 60 * 60 * 1000);
    const listed = rendered(listPayoutTransactions(app.context, id, new URLSearchParams())).body as JsonObject;
    expect((listed['results'] as JsonObject[])[0]).toMatchObject({ status: 'processed', status_detail: 'accredited' });
    expect(app.context.store.documents.get('payout', id)?.status).toBe('processed');
  });

  test('a cancelled transfer next to a settled one leaves the batch partially processed', () => {
    const app = harness();
    const created = payout(createPayout(app.context, batch([pix('a@b.c', 10), account(20)], 30)));
    const id = created['id'] as string;
    const pending = transactions(created)[1];

    cancelPayoutTransaction(app.context, id, pending?.['id'] as string);
    const stored = app.context.store.documents.get('payout', id);
    expect(stored?.status).toBe('partially_processed');
    expect(stored?.doc['status']).toBe('partially_processed');
  });
});

describe('transaction intents', () => {
  const intentBody = {
    external_reference: 'PAYOUT-001',
    point_of_interaction: { type: 'PIX' },
    transaction: { amount: 100, currency_id: 'BRL', receiver: { pix_key: 'seller@shop.com' } },
  };

  test('produces a real payment and reports it', () => {
    const app = harness();
    const created = rendered(processTransactionIntent(app.context, intentBody));
    expect(created.status).toBe(201);
    const body = created.body as JsonObject;
    const payment = body['payment'] as JsonObject;

    expect(body['status']).toBe('pending');
    expect(body['external_reference']).toBe('PAYOUT-001');
    expect(payment['payment_method_id']).toBe('pix');
    expect(payment['transaction_amount']).toBe(100);
    expect(String(body['payment_id'])).toBe(String(payment['id']));

    const found = rendered(getTransactionIntent(app.context, body['id'] as string)).body as JsonObject;
    expect(found['payment_id']).toBe(body['payment_id']);
    expect((found['payment'] as JsonObject)['id']).toBe(payment['id']);
    expect(found['transaction']).toEqual({
      amount: 100,
      currency_id: 'BRL',
      receiver: { pix_key: 'seller@shop.com' },
    });
  });

  test('the intent status follows the payment it produced', () => {
    const app = harness();
    const body = rendered(processTransactionIntent(app.context, intentBody)).body as JsonObject;
    const id = body['id'] as string;

    // The Pix charge expires once its deadline passes, and the intent reports that.
    app.clock.advance(2 * 24 * 60 * 60 * 1000);
    const found = rendered(getTransactionIntent(app.context, id)).body as JsonObject;
    expect(found['status']).toBe('cancelled');
    expect(app.context.store.documents.get('transaction_intent', id)?.status).toBe('cancelled');
  });

  test('reports the rail the payment was actually created on', () => {
    const app = harness();
    const body = rendered(
      processTransactionIntent(app.context, { ...intentBody, payment_method_id: 'pix' }),
    ).body as JsonObject;
    expect(body['point_of_interaction']).toEqual({ type: 'PIX' });
  });

  test('rejects a rail the payments catalogue does not emulate', () => {
    const app = harness();
    const error = failure(
      processTransactionIntent(app.context, {
        ...intentBody,
        point_of_interaction: { type: 'BANK_TRANSFER' },
      }),
    );
    expect(error.status).toBe(400);
  });

  test('rejects malformed intents and unknown ids', () => {
    const app = harness();
    expect(failure(processTransactionIntent(app.context, 'nope')).status).toBe(400);
    expect(failure(processTransactionIntent(app.context, { transaction: { amount: 0 } })).status).toBe(400);
    expect(
      failure(processTransactionIntent(app.context, { transaction: { amount: 10, currency_id: 'ARS' } })).status,
    ).toBe(400);
    expect(failure(getTransactionIntent(app.context, 'missing')).status).toBe(404);
    expect(
      failure(processTransactionIntent(app.context, { transaction: { amount: 10, receiver: { branch: '1' } } }))
        .cause[0]?.description,
    ).toContain('transaction.receiver');
  });
});
