import { describe, expect, test } from 'bun:test';
import { type JsonObject, type Payment, apply, unwrap } from '@payground/core';
import { createCardToken } from './card-tokens.ts';
import type { ServiceContext } from './context.ts';
import { DOCUMENTATION_WINDOW_MS, cancelPayment, getChargeback, getRefund, updateChargeback } from './disputes.ts';
import { type Harness, cardPaymentBody, cardTokenBody, harness } from './fixture.ts';
import { createPayment, createRefund, getPayment } from './payments.ts';

function pay(app: Harness, overrides: Record<string, unknown> = {}): JsonObject {
  const token = unwrap(createCardToken(app.context, cardTokenBody())).body as { id?: string };
  return unwrap(createPayment(app.context, cardPaymentBody(token.id ?? '', overrides))).body as JsonObject;
}

/** The control API is what opens a dispute; here we drive the same domain command. */
function dispute(context: ServiceContext, sequence: number): Payment {
  const payment = context.store.payments.bySequence(sequence);
  if (payment === null) throw new Error('expected a payment');
  const transition = apply(payment, { type: 'dispute' }, context.clock.now());
  if (!transition.ok) throw new Error('expected a dispute');
  context.store.payments.update(transition.value.payment);
  context.store.payments.record(transition.value);
  return transition.value.payment;
}

const chargeback = (context: ServiceContext, id: number): JsonObject =>
  unwrap(getChargeback(context, String(id))).body as JsonObject;

const statusOf = (context: ServiceContext, id: number): string =>
  (unwrap(getPayment(context, String(id))).body as { status: string }).status;

describe('chargebacks', () => {
  test('are unknown until the payment is disputed', () => {
    const app = harness();
    const payment = pay(app);
    const missing = getChargeback(app.context, String(payment['id']));
    expect(missing.ok).toBe(false);
    expect(missing.ok ? null : missing.error.status).toBe(404);
  });

  test('carry the disputed amount, the deadline and the coverage flags', () => {
    const app = harness();
    const payment = pay(app);
    const id = payment['id'] as number;
    dispute(app.context, id);

    expect(chargeback(app.context, id)).toMatchObject({
      id: String(id),
      payment_id: id,
      payments: [id],
      currency: 'BRL',
      amount: 100.5,
      status: 'pending',
      coverage_applied: false,
      coverage_elegible: true,
      documentation_required: true,
      documentation_status: 'not_supplied',
      documentation: [],
    });
    expect(statusOf(app.context, id)).toBe('in_mediation');
  });

  test('documentation settles the dispute in the collector favour', () => {
    const app = harness();
    const id = pay(app)['id'] as number;
    dispute(app.context, id);

    const updated = unwrap(
      updateChargeback(app.context, String(id), {
        files: [{ name: 'invoice.pdf', description: 'proof', url: 'https://example.com/invoice.pdf' }],
      }),
    ).body as JsonObject;

    expect(updated).toMatchObject({
      status: 'won',
      documentation_status: 'valid',
      documentation_required: false,
      coverage_applied: false,
    });
    expect(updated['documentation']).toEqual([
      { name: 'invoice.pdf', description: 'proof', url: 'https://example.com/invoice.pdf' },
    ]);
    expect(statusOf(app.context, id)).toBe('approved');
  });

  test('reject an empty documentation upload and a settled dispute', () => {
    const app = harness();
    const id = pay(app)['id'] as number;
    dispute(app.context, id);

    const empty = updateChargeback(app.context, String(id), { files: [] });
    expect(empty.ok ? null : empty.error.status).toBe(400);

    unwrap(updateChargeback(app.context, String(id), { files: [{ url: 'https://example.com/a.pdf' }] }));
    const again = updateChargeback(app.context, String(id), { files: [{ url: 'https://example.com/a.pdf' }] });
    expect(again.ok ? null : again.error.status).toBe(422);
  });

  test('the payment is charged back once the documentation deadline passes', () => {
    const app = harness();
    const id = pay(app)['id'] as number;
    dispute(app.context, id);

    app.clock.advance(DOCUMENTATION_WINDOW_MS);
    expect(chargeback(app.context, id)).toMatchObject({ status: 'lost', coverage_applied: true });
    expect(statusOf(app.context, id)).toBe('charged_back');
  });

  test('a control-driven resolution is picked up on read', () => {
    const app = harness();
    const id = pay(app)['id'] as number;
    const disputed = dispute(app.context, id);

    const resolved = apply(disputed, { type: 'resolve', outcome: 'chargeback' }, app.clock.now());
    if (!resolved.ok) throw new Error('expected a resolution');
    app.context.store.payments.update(resolved.value.payment);
    app.context.store.payments.record(resolved.value);

    expect(chargeback(app.context, id)).toMatchObject({ status: 'lost', documentation_required: false });
  });

  test('a second dispute reopens the resource', () => {
    const app = harness();
    const id = pay(app)['id'] as number;
    dispute(app.context, id);
    unwrap(updateChargeback(app.context, String(id), { files: [{ url: 'https://example.com/a.pdf' }] }));

    app.clock.advance(1_000);
    dispute(app.context, id);
    expect(chargeback(app.context, id)).toMatchObject({ status: 'pending', documentation_status: 'not_supplied' });

    unwrap(updateChargeback(app.context, String(id), { files: [{ url: 'https://example.com/b.pdf' }] }));
    // Reading twice proves the reopen guard does not wipe the evidence on every read.
    expect(chargeback(app.context, id)).toMatchObject({ status: 'won', documentation_status: 'valid' });
    expect(chargeback(app.context, id)).toMatchObject({ status: 'won', documentation_status: 'valid' });
  });
});

describe('getRefund', () => {
  test('returns the single refund the list reports', () => {
    const app = harness();
    const id = pay(app)['id'] as number;
    const created = unwrap(createRefund(app.context, String(id), { amount: 10 })).body as JsonObject;

    const found = unwrap(getRefund(app.context, String(id), String(created['id']))).body;
    expect(found).toMatchObject({ id: created['id'], payment_id: id, amount: 10, status: 'approved' });
  });

  test('is a 404 for an unknown refund or payment', () => {
    const app = harness();
    const id = pay(app)['id'] as number;
    expect(getRefund(app.context, String(id), '99').ok).toBe(false);
    expect(getRefund(app.context, '1', '99').ok).toBe(false);
  });
});

describe('cancelPayment', () => {
  test('cancels a pending payment exactly like the payment update', () => {
    const app = harness();
    const payment = unwrap(
      createPayment(app.context, {
        transaction_amount: 25,
        payment_method_id: 'pix',
        payer: { email: 'payer@example.com' },
      }),
    ).body as JsonObject;

    const cancelled = unwrap(cancelPayment(app.context, String(payment['id']), { status: 'cancelled' }))
      .body as JsonObject;
    expect(cancelled).toMatchObject({ status: 'cancelled', status_detail: 'by_collector' });
  });

  test('only accepts a cancelled status', () => {
    const app = harness();
    const id = pay(app)['id'] as number;
    const wrong = cancelPayment(app.context, String(id), { status: 'approved' });
    expect(wrong.ok ? null : wrong.error.status).toBe(400);
    const empty = cancelPayment(app.context, String(id), null);
    expect(empty.ok ? null : empty.error.status).toBe(400);
  });

  test('refuses to cancel an approved payment', () => {
    const app = harness();
    const id = pay(app)['id'] as number;
    const result = cancelPayment(app.context, String(id), { status: 'cancelled' });
    expect(result.ok ? null : result.error.status).toBe(422);
  });
});
