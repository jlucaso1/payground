import { describe, expect, test } from 'bun:test';
import { type JsonObject, unwrap } from '@payground/core';
import {
  aggregateStatus,
  createAdvancedPayment,
  getAdvancedPayment,
  updateAdvancedPayment,
} from './advanced-payments.ts';
import { createCardToken } from './card-tokens.ts';
import type { ServiceContext } from './context.ts';
import { type Harness, cardTokenBody, harness } from './fixture.ts';

const token = (context: ServiceContext, cardholder = 'APRO'): string => {
  const created = unwrap(createCardToken(context, cardTokenBody({ cardholder: { name: cardholder } })))
    .body as { id?: string };
  return created.id ?? '';
};

const payer = { email: 'payer@example.com' };

function body(app: Harness, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    payments: [{ payment_method_id: 'visa', token: token(app.context), transaction_amount: 100 }],
    disbursements: [
      { amount: 60, collector_id: 11, application_fee: 6, money_release_days: 5 },
      { amount: 40, collector_id: 22, application_fee: 4, money_release_days: 10 },
    ],
    payer,
    external_reference: 'SPLIT-1',
    ...overrides,
  };
}

const created = (app: Harness, overrides: Record<string, unknown> = {}): JsonObject =>
  unwrap(createAdvancedPayment(app.context, body(app, overrides))).body as JsonObject;

const payments = (advanced: JsonObject): JsonObject[] => advanced['payments'] as JsonObject[];

describe('aggregateStatus', () => {
  test('reports the least advanced outcome', () => {
    expect(aggregateStatus(['approved', 'approved'])).toBe('approved');
    expect(aggregateStatus(['approved', 'rejected'])).toBe('rejected');
    expect(aggregateStatus(['approved', 'pending'])).toBe('pending');
    expect(aggregateStatus(['authorized', 'approved'])).toBe('authorized');
    expect(aggregateStatus(['cancelled', 'cancelled'])).toBe('cancelled');
    expect(aggregateStatus([])).toBe('pending');
  });
});

describe('createAdvancedPayment', () => {
  test('collects the payments and schedules every disbursement', () => {
    const app = harness();
    const advanced = created(app);

    expect(advanced).toMatchObject({
      status: 'approved',
      site_id: 'MLB',
      external_reference: 'SPLIT-1',
      application_fee: 10,
      money_release_days: 10,
      capture: true,
      binary_mode: false,
    });
    expect(payments(advanced)).toHaveLength(1);
    expect(payments(advanced)[0]).toMatchObject({ status: 'approved', transaction_amount: 100 });
    expect(advanced['disbursements']).toMatchObject([
      { collector_id: 11, amount: 60, application_fee: 6, money_release_days: 5 },
      { collector_id: 22, amount: 40, application_fee: 4, money_release_days: 10 },
    ]);
  });

  test('the split must add up to the collected amount', () => {
    const app = harness();
    const result = createAdvancedPayment(
      app.context,
      body(app, { disbursements: [{ amount: 60, collector_id: 11 }] }),
    );
    expect(result.ok ? null : result.error.status).toBe(400);
    expect(result.ok ? '' : result.error.cause[0]?.description).toContain('add up');
  });

  test('rejects a missing split and an application fee above its disbursement', () => {
    const app = harness();
    expect(createAdvancedPayment(app.context, body(app, { disbursements: [] })).ok).toBe(false);
    expect(
      createAdvancedPayment(app.context, body(app, { disbursements: [{ amount: 100, application_fee: 200 }] }))
        .ok,
    ).toBe(false);
    expect(createAdvancedPayment(app.context, { payer }).ok).toBe(false);
  });

  test('gives back what was collected when a later split payment fails', () => {
    const app = harness();
    const result = createAdvancedPayment(app.context, {
      payments: [
        { payment_method_id: 'visa', token: token(app.context), transaction_amount: 40 },
        { payment_method_id: 'visa', token: 'not-a-token', transaction_amount: 60 },
      ],
      disbursements: [{ amount: 100 }],
      payer,
    });
    expect(result.ok).toBe(false);

    const collected = app.context.store.payments.search({}).results;
    expect(collected).toHaveLength(1);
    expect(collected[0]?.status.state).toBe('refunded');
  });

  test('a rejected split gives back what the other payments collected', () => {
    const app = harness();
    const advanced = unwrap(
      createAdvancedPayment(app.context, {
        payments: [
          { payment_method_id: 'visa', token: token(app.context), transaction_amount: 40 },
          { payment_method_id: 'visa', token: token(app.context, 'FUND'), transaction_amount: 60 },
        ],
        disbursements: [{ amount: 100 }],
        payer,
      }),
    ).body as JsonObject;

    expect(advanced['status']).toBe('rejected');
    const states = app.context.store.payments.search({}).results.map((payment) => payment.status.state);
    expect(states.sort()).toEqual(['failed', 'refunded']);
  });

  test('a split left under review is declined when a later payment fails', () => {
    const app = harness();
    const result = createAdvancedPayment(app.context, {
      payments: [
        { payment_method_id: 'visa', token: token(app.context, 'CONT'), transaction_amount: 40 },
        { payment_method_id: 'visa', token: 'not-a-token', transaction_amount: 60 },
      ],
      disbursements: [{ amount: 100 }],
      payer,
    });

    expect(result.ok).toBe(false);
    expect(app.context.store.payments.search({}).results[0]?.status.state).toBe('failed');
  });

  test('rejects amounts that cannot be added up', () => {
    const app = harness();
    const huge = Number.MAX_SAFE_INTEGER / 100;
    const result = createAdvancedPayment(app.context, {
      payments: [
        { payment_method_id: 'account_money', transaction_amount: huge },
        { payment_method_id: 'account_money', transaction_amount: huge },
      ],
      disbursements: [{ amount: huge }],
      payer,
    });
    expect(result.ok ? null : result.error.status).toBe(400);
  });

  test('accepts the Wallet Connect wallet_payment shape', () => {
    const app = harness();
    const advanced = unwrap(
      createAdvancedPayment(app.context, {
        wallet_payment: { transaction_amount: 30, description: 'wallet' },
        disbursements: [{ amount: 30 }],
        payer: { token: 'wallet-token', type_token: 'card' },
      }),
    ).body as JsonObject;

    expect(advanced['status']).toBe('approved');
    expect(payments(advanced)[0]).toMatchObject({
      payment_method_id: 'account_money',
      description: 'wallet',
    });
  });
});

describe('getAdvancedPayment', () => {
  test('recomputes the status from the split payments', () => {
    const app = harness();
    const advanced = created(app, { capture: false });
    expect(advanced['status']).toBe('authorized');

    const read = unwrap(getAdvancedPayment(app.context, String(advanced['id']))).body as JsonObject;
    expect(read).toMatchObject({ id: advanced['id'], status: 'authorized' });
  });

  test('is a 404 for an unknown id', () => {
    const app = harness();
    expect(getAdvancedPayment(app.context, '3000000999').ok).toBe(false);
    expect(getAdvancedPayment(app.context, 'nope').ok).toBe(false);
  });
});

describe('updateAdvancedPayment', () => {
  test('captures every authorized split payment', () => {
    const app = harness();
    const advanced = created(app, { capture: false });

    const captured = unwrap(updateAdvancedPayment(app.context, String(advanced['id']), { capture: true }))
      .body as JsonObject;
    expect(captured['status']).toBe('approved');
    expect(payments(captured)[0]).toMatchObject({ status: 'approved' });
  });

  test('cancels every split payment', () => {
    const app = harness();
    const advanced = created(app, { capture: false });

    const cancelled = unwrap(
      updateAdvancedPayment(app.context, String(advanced['id']), { status: 'cancelled' }),
    ).body as JsonObject;
    expect(cancelled['status']).toBe('cancelled');
  });

  test('refuses a command a split payment cannot accept', () => {
    const app = harness();
    const advanced = created(app);
    const result = updateAdvancedPayment(app.context, String(advanced['id']), { status: 'cancelled' });
    expect(result.ok ? null : result.error.status).toBe(422);
  });

  test('refuses to cancel when a split payment has already expired', () => {
    const app = harness();
    const advanced = unwrap(
      createAdvancedPayment(app.context, {
        payments: [
          { payment_method_id: 'visa', token: token(app.context), transaction_amount: 40 },
          { payment_method_id: 'pix', transaction_amount: 60 },
        ],
        disbursements: [{ amount: 100 }],
        payer,
        capture: false,
      }),
    ).body as JsonObject;

    app.clock.advance(2 * 24 * 60 * 60 * 1000);
    const result = updateAdvancedPayment(app.context, String(advanced['id']), { status: 'cancelled' });
    expect(result.ok ? null : result.error.status).toBe(422);

    const states = app.context.store.payments.search({}).results.map((payment) => payment.status.state);
    expect(states).toContain('authorized');
  });

  test('rejects a body with nothing to update', () => {
    const app = harness();
    const advanced = created(app);
    const result = updateAdvancedPayment(app.context, String(advanced['id']), {});
    expect(result.ok ? null : result.error.status).toBe(400);
  });
});
