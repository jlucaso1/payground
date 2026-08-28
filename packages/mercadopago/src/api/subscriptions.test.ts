import { describe, expect, test } from 'bun:test';
import { type Result, type Sandbox, type StoredDocument, sandboxId } from '@payground/core';
import { ManualClock, SeededIdGenerator, SeededRandom } from '@payground/core/testing.ts';
import { Storage } from '@payground/storage';
import type { ErrorBody } from '../errors.ts';
import type { EventNotice, Rendered, ServiceContext } from './context.ts';
import {
  createPlan,
  createSubscription,
  getAuthorizedPayment,
  getPlan,
  getSubscription,
  runBilling,
  searchAuthorizedPayments,
  searchPlans,
  searchSubscriptions,
  updatePlan,
  updateSubscription,
} from './subscriptions.ts';

const START = Date.UTC(2024, 0, 10, 12, 0, 0);
const DAY = 86_400_000;

interface Harness {
  context: ServiceContext;
  clock: ManualClock;
  events: EventNotice[];
}

function harness(startAt: number = START): Harness {
  const storage = Storage.open();
  const id = sandboxId('00000000-0000-4000-8000-00000000sbx');
  const sandbox: Sandbox = {
    id,
    name: 'test',
    accessToken: 'TEST-token',
    publicKey: 'TEST-key',
    webhookSecret: 'secret',
    liveMode: false,
    createdAt: startAt,
  };
  storage.sandboxes.create(sandbox);
  const clock = new ManualClock(startAt);
  const events: EventNotice[] = [];
  const context: ServiceContext = {
    store: storage.forSandbox(id),
    sandbox,
    clock,
    ids: new SeededIdGenerator(1),
    baseUrl: 'http://localhost:8080',
    collectorId: 123_456_789,
    events: {
      emit(notice) {
        events.push(notice);
      },
    },
  };
  return { context, clock, events };
}

type Loose = Record<string, unknown>;

function body(result: Result<Rendered, ErrorBody>): Loose {
  if (!result.ok) throw new Error(`unexpected error: ${JSON.stringify(result.error)}`);
  return result.value.body as Loose;
}

function failure(result: Result<Rendered, ErrorBody>): ErrorBody {
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result.value.body)}`);
  return result.error;
}

const nested = (value: Loose, key: string): Loose => value[key] as Loose;
const list = (value: Loose): Loose[] => value['results'] as Loose[];
const topics = (events: readonly EventNotice[]): string[] =>
  events.map((notice) => (notice as unknown as Loose)['type'] as string);

interface PlanOptions {
  frequency?: number;
  frequency_type?: string;
  transaction_amount?: number;
  repetitions?: number;
  billing_day?: number;
  billing_day_proportional?: boolean;
  free_trial?: { frequency: number; frequency_type: string };
}

const recurring = (options: PlanOptions = {}): Loose => ({
  frequency: options.frequency ?? 1,
  frequency_type: options.frequency_type ?? 'months',
  transaction_amount: options.transaction_amount ?? 29.9,
  currency_id: 'BRL',
  ...(options.repetitions === undefined ? {} : { repetitions: options.repetitions }),
  ...(options.billing_day === undefined ? {} : { billing_day: options.billing_day }),
  ...(options.billing_day_proportional === undefined
    ? {}
    : { billing_day_proportional: options.billing_day_proportional }),
  ...(options.free_trial === undefined ? {} : { free_trial: options.free_trial }),
});

const planRequest = (options: PlanOptions = {}): Loose => ({
  reason: 'Monthly Premium Subscription',
  auto_recurring: recurring(options),
  back_url: 'https://merchant.test/back',
});

function subscribe(context: ServiceContext, options: PlanOptions = {}, extra: Loose = {}): Loose {
  return body(
    createSubscription(context, {
      reason: 'Monthly Premium Subscription',
      payer_email: 'payer@example.com',
      card_token_id: 'card-token-1',
      auto_recurring: recurring(options),
      ...extra,
    }),
  );
}

const invoices = (context: ServiceContext, id: string): Loose[] =>
  list(body(searchAuthorizedPayments(context, new URLSearchParams({ preapproval_id: id, limit: '1000' }))));

describe('plans', () => {
  test('creates and reads back a plan', () => {
    const { context, events } = harness();
    const created = createPlan(context, planRequest());
    expect(created.ok && created.value.status).toBe(201);

    const plan = body(created);
    expect(typeof plan['id']).toBe('string');
    expect(plan['status']).toBe('active');
    expect(plan['init_point']).toBe(`http://localhost:8080/subscriptions/checkout?preapproval_plan_id=${plan['id']}`);
    expect(nested(plan, 'auto_recurring')['transaction_amount']).toBe(29.9);
    expect(topics(events)).toEqual(['subscription_preapproval_plan']);

    const fetched = body(getPlan(context, plan['id'] as string));
    expect(fetched['id']).toBe(plan['id']);
    expect(getPlan(context, 'missing').ok).toBe(false);
  });

  test('rejects invalid recurrence terms', () => {
    const { context } = harness();
    const cases: PlanOptions[] = [
      { frequency: 0 },
      { frequency_type: 'weeks' },
      { transaction_amount: 0 },
      { transaction_amount: 10.005 },
      { repetitions: 0 },
      { billing_day: 32 },
      { billing_day: 5, frequency_type: 'days' },
      { billing_day_proportional: true },
    ];
    for (const option of cases) {
      const result = createPlan(context, planRequest(option));
      expect(result.ok).toBe(false);
      expect(failure(result).status).toBe(400);
    }
    expect(failure(createPlan(context, { reason: 'x' })).status).toBe(400);
    expect(failure(createPlan(context, 'nope')).status).toBe(400);
  });

  test('only BRL is billable', () => {
    const { context } = harness();
    const result = createPlan(context, {
      reason: 'x',
      auto_recurring: { ...recurring(), currency_id: 'ARS' },
    });
    expect(failure(result).cause[0]?.description).toContain('currency_id');
  });

  test('updates and searches plans', () => {
    const { context } = harness();
    const plan = body(createPlan(context, planRequest()));
    const id = plan['id'] as string;

    const updated = body(updatePlan(context, id, { reason: 'Yearly access', status: 'inactive' }));
    expect(updated['reason']).toBe('Yearly access');
    expect(updated['status']).toBe('inactive');
    expect(failure(updatePlan(context, id, { auto_recurring: recurring({ frequency: -1 }) })).status).toBe(400);
    expect(updatePlan(context, 'missing', {}).ok).toBe(false);

    body(createPlan(context, planRequest()));
    const all = body(searchPlans(context, new URLSearchParams()));
    expect(nested(all, 'paging')['total']).toBe(2);

    const active = body(searchPlans(context, new URLSearchParams({ status: 'active' })));
    expect(list(active)).toHaveLength(1);

    const byQuery = body(searchPlans(context, new URLSearchParams({ q: 'yearly' })));
    expect(list(byQuery)[0]?.['id']).toBe(id);

    const paged = body(searchPlans(context, new URLSearchParams({ limit: '1', offset: '1' })));
    expect(list(paged)).toHaveLength(1);
    expect(nested(paged, 'paging')['total']).toBe(2);
  });
});

describe('subscriptions', () => {
  test('a card token authorizes immediately', () => {
    const { context, events } = harness();
    const subscription = subscribe(context);
    expect(subscription['status']).toBe('authorized');
    expect(subscription['payer_id']).toBeGreaterThan(0);
    expect(Date.parse(subscription['next_payment_date'] as string)).toBe(START);
    expect(topics(events)).toEqual(['subscription_preapproval']);
  });

  test('without a card token it stays pending and exposes an init_point', () => {
    const { context } = harness();
    const subscription = body(
      createSubscription(context, {
        reason: 'Monthly',
        payer_email: 'payer@example.com',
        auto_recurring: recurring(),
      }),
    );
    expect(subscription['status']).toBe('pending');
    expect(subscription['next_payment_date']).toBeUndefined();
    expect(subscription['init_point']).toBe(
      `http://localhost:8080/subscriptions/checkout?preapproval_id=${subscription['id']}`,
    );
    expect(runBilling(context, START + 400 * DAY)).toEqual({ charged: 0, failed: 0 });
  });

  test('inherits the terms of its plan', () => {
    const { context } = harness();
    const plan = body(createPlan(context, planRequest({ transaction_amount: 12.5 })));
    const subscription = body(
      createSubscription(context, {
        preapproval_plan_id: plan['id'],
        payer_email: 'payer@example.com',
        card_token_id: 'token',
      }),
    );
    expect(subscription['preapproval_plan_id']).toBe(plan['id']);
    expect(nested(subscription, 'auto_recurring')['transaction_amount']).toBe(12.5);
    expect(subscription['reason']).toBe('Monthly Premium Subscription');

    expect(failure(createSubscription(context, { preapproval_plan_id: 'nope', payer_email: 'a@b.c' })).status).toBe(400);
    body(updatePlan(context, plan['id'] as string, { status: 'inactive' }));
    expect(
      failure(createSubscription(context, { preapproval_plan_id: plan['id'], payer_email: 'a@b.c' })).cause[0]
        ?.description,
    ).toContain('not active');
  });

  test('validates the payer and the requested status', () => {
    const { context } = harness();
    expect(failure(createSubscription(context, { payer_email: 'nope', auto_recurring: recurring() })).status).toBe(400);
    expect(
      failure(
        createSubscription(context, {
          reason: 'M',
          payer_email: 'a@b.c',
          auto_recurring: recurring(),
          status: 'authorized',
        }),
      ).cause[0]?.description,
    ).toContain('card_token_id');
    const missing = failure(createSubscription(context, { reason: 'M', payer_email: 'a@b.c' }));
    expect(missing.cause.map((cause) => cause.description).join()).toContain('auto_recurring');
  });

  test('pending becomes authorized when a card token arrives', () => {
    const { context, clock } = harness();
    const subscription = body(
      createSubscription(context, { reason: 'M', payer_email: 'a@b.c', auto_recurring: recurring() }),
    );
    const id = subscription['id'] as string;
    expect(failure(updateSubscription(context, id, { status: 'authorized' })).status).toBe(400);

    clock.advance(DAY);
    const authorized = body(updateSubscription(context, id, { status: 'authorized', card_token_id: 'token' }));
    expect(authorized['status']).toBe('authorized');
    expect(Date.parse(authorized['next_payment_date'] as string)).toBe(START + DAY);
  });

  test('pause, resume and cancel are terminal-aware', () => {
    const { context, clock } = harness();
    const id = subscribe(context)['id'] as string;

    expect(body(updateSubscription(context, id, { status: 'paused' }))['status']).toBe('paused');
    clock.advance(40 * DAY);
    expect(runBilling(context, clock.now())).toEqual({ charged: 0, failed: 0 });

    // A paused period is not billed retroactively: the missed cycles are skipped on resume.
    const resumed = body(updateSubscription(context, id, { status: 'authorized' }));
    expect(resumed['status']).toBe('authorized');
    expect(Date.parse(resumed['next_payment_date'] as string)).toBe(Date.UTC(2024, 2, 10, 12));
    expect(runBilling(context, clock.now())).toEqual({ charged: 0, failed: 0 });

    expect(body(updateSubscription(context, id, { status: 'cancelled' }))['status']).toBe('cancelled');
    const revived = failure(updateSubscription(context, id, { status: 'authorized' }));
    expect(revived.status).toBe(422);
    expect(failure(updateSubscription(context, id, { reason: 'anything' })).status).toBe(422);
    expect(runBilling(context, clock.now() + 400 * DAY)).toEqual({ charged: 0, failed: 0 });
  });

  test('rejects a move back to pending', () => {
    const { context } = harness();
    const id = subscribe(context)['id'] as string;
    expect(failure(updateSubscription(context, id, { status: 'pending' })).status).toBe(422);
    expect(failure(updateSubscription(context, 'missing', {})).status).toBe(404);
    expect(failure(updateSubscription(context, id, { status: 'unknown' })).status).toBe(400);
  });

  test('searches by email, plan, status and reason', () => {
    const { context } = harness();
    const plan = body(createPlan(context, planRequest()));
    const first = subscribe(context, {}, { external_reference: 'ref-1' });
    subscribe(context, {}, { payer_email: 'other@example.com', reason: 'Gold tier' });
    body(
      createSubscription(context, {
        preapproval_plan_id: plan['id'],
        payer_email: 'third@example.com',
        card_token_id: 'token',
      }),
    );

    const byEmail = body(searchSubscriptions(context, new URLSearchParams({ payer_email: 'other@example.com' })));
    expect(list(byEmail)).toHaveLength(1);

    const byPlan = body(
      searchSubscriptions(context, new URLSearchParams({ preapproval_plan_id: plan['id'] as string })),
    );
    expect(list(byPlan)).toHaveLength(1);

    const byQuery = body(searchSubscriptions(context, new URLSearchParams({ q: 'gold' })));
    expect(list(byQuery)).toHaveLength(1);

    const byReference = body(searchSubscriptions(context, new URLSearchParams({ external_reference: 'ref-1' })));
    expect(list(byReference)[0]?.['id']).toBe(first['id']);

    const byPayer = body(
      searchSubscriptions(context, new URLSearchParams({ payer_id: String(first['payer_id']) })),
    );
    expect(list(byPayer).length).toBeGreaterThanOrEqual(1);

    const byAmount = body(searchSubscriptions(context, new URLSearchParams({ transaction_amount: '1' })));
    expect(list(byAmount)).toHaveLength(0);

    const authorized = body(searchSubscriptions(context, new URLSearchParams({ status: 'authorized' })));
    expect(nested(authorized, 'paging')['total']).toBe(3);
  });
});

describe('billing', () => {
  test('charges a monthly subscription once per month across a year', () => {
    const { context } = harness();
    const subscription = subscribe(context);
    const id = subscription['id'] as string;

    let charged = 0;
    for (let month = 0; month < 12; month++) {
      const at = Date.UTC(2024, month, 10, 12);
      charged += runBilling(context, at).charged;
      expect(charged).toBe(month + 1);
    }
    expect(runBilling(context, Date.UTC(2024, 11, 31, 12))).toEqual({ charged: 0, failed: 0 });

    const current = body(getSubscription(context, id));
    expect(nested(current, 'summarized')['charged_quantity']).toBe(12);
    expect(nested(current, 'summarized')['charged_amount']).toBeCloseTo(12 * 29.9, 6);
    expect(Date.parse(current['next_payment_date'] as string)).toBe(Date.UTC(2025, 0, 10, 12));

    const paid = invoices(context, id);
    expect(paid).toHaveLength(12);
    expect(paid.every((invoice) => invoice['status'] === 'processed')).toBe(true);
    expect(paid.every((invoice) => nested(invoice, 'payment')['status'] === 'approved')).toBe(true);
  });

  test('one call catches up on every cycle that is due', () => {
    const { context } = harness();
    const id = subscribe(context)['id'] as string;
    expect(runBilling(context, Date.UTC(2024, 11, 10, 12))).toEqual({ charged: 12, failed: 0 });
    expect(invoices(context, id)).toHaveLength(12);
  });

  test('charges a daily subscription every day across a leap year', () => {
    const { context } = harness(Date.UTC(2024, 0, 1, 9, 0, 0));
    const id = subscribe(context, { frequency: 1, frequency_type: 'days', transaction_amount: 1 })['id'] as string;
    const result = runBilling(context, Date.UTC(2024, 11, 31, 9));
    expect(result).toEqual({ charged: 366, failed: 0 });
    expect(invoices(context, id)).toHaveLength(366);
  });

  test('stops after repetitions', () => {
    const { context } = harness();
    const id = subscribe(context, { repetitions: 3 })['id'] as string;
    expect(runBilling(context, START + 400 * DAY).charged).toBe(3);
    expect(runBilling(context, START + 800 * DAY).charged).toBe(0);

    const current = body(getSubscription(context, id));
    expect(nested(current, 'summarized')['quotas']).toBe(3);
    expect(nested(current, 'summarized')['pending_charge_quantity']).toBe(0);
    expect(nested(current, 'summarized')['pending_charge_amount']).toBe(0);
    expect(current['next_payment_date']).toBeUndefined();
    expect(current['status']).toBe('authorized');
  });

  test('skips charges until the free trial ends', () => {
    const { context } = harness();
    const subscription = subscribe(context, { free_trial: { frequency: 1, frequency_type: 'months' } });
    const id = subscription['id'] as string;
    expect(Date.parse(subscription['next_payment_date'] as string)).toBe(Date.UTC(2024, 1, 10, 12));

    expect(runBilling(context, Date.UTC(2024, 1, 9, 12))).toEqual({ charged: 0, failed: 0 });
    expect(runBilling(context, Date.UTC(2024, 1, 10, 12))).toEqual({ charged: 1, failed: 0 });
    expect(invoices(context, id)).toHaveLength(1);
  });

  test('a proportional billing day charges the partial period up front', () => {
    const { context } = harness();
    const subscription = subscribe(context, { billing_day: 20, billing_day_proportional: true });
    const id = subscription['id'] as string;
    expect(Date.parse(subscription['next_payment_date'] as string)).toBe(START);

    expect(runBilling(context, START)).toEqual({ charged: 1, failed: 0 });
    const first = invoices(context, id);
    expect(first).toHaveLength(1);
    // 10 of the 31 days of January, at 29.90 a month.
    expect(first[0]?.['transaction_amount']).toBeCloseTo(9.65, 6);

    expect(Date.parse(body(getSubscription(context, id))['next_payment_date'] as string)).toBe(
      Date.UTC(2024, 0, 20, 12),
    );

    expect(runBilling(context, Date.UTC(2024, 1, 20, 12))).toEqual({ charged: 2, failed: 0 });
    const all = invoices(context, id);
    expect(all).toHaveLength(3);
    const summarized = nested(body(getSubscription(context, id)), 'summarized');
    expect(summarized['charged_quantity']).toBe(3);
  });

  test('a non-proportional billing day waits for that day', () => {
    const { context } = harness();
    const subscription = subscribe(context, { billing_day: 20 });
    expect(Date.parse(subscription['next_payment_date'] as string)).toBe(Date.UTC(2024, 0, 20, 12));
    expect(runBilling(context, Date.UTC(2024, 0, 19, 12))).toEqual({ charged: 0, failed: 0 });
    expect(runBilling(context, Date.UTC(2024, 0, 20, 12))).toEqual({ charged: 1, failed: 0 });
  });

  test('a 31st billing day clamps to the end of short months', () => {
    const { context } = harness(Date.UTC(2024, 0, 15, 12));
    const id = subscribe(context, { billing_day: 31 })['id'] as string;
    const expected = [
      Date.UTC(2024, 0, 31, 12),
      Date.UTC(2024, 1, 29, 12),
      Date.UTC(2024, 2, 31, 12),
      Date.UTC(2024, 3, 30, 12),
    ];

    for (const [index, at] of expected.entries()) {
      expect(Date.parse(body(getSubscription(context, id))['next_payment_date'] as string)).toBe(at);
      expect(runBilling(context, at).charged).toBe(1);
      expect(nested(body(getSubscription(context, id)), 'summarized')['charged_quantity']).toBe(index + 1);
    }
    // Clamping never drifts: the anchor day is kept, not the previous charge day.
    expect(Date.parse(body(getSubscription(context, id))['next_payment_date'] as string)).toBe(
      Date.UTC(2024, 4, 31, 12),
    );
  });

  test('a failed charge is retried instead of dropping the subscription', () => {
    const { context, clock } = harness();
    const id = subscribe(context)['id'] as string;
    const stored = context.store.documents.get('preapproval', id) as StoredDocument;
    const broken = { ...stored.doc, auto_recurring: { ...(stored.doc['auto_recurring'] as Loose), transaction_amount: 0.005 } };
    context.store.documents.update({ ...stored, doc: broken as never });

    expect(runBilling(context, START)).toEqual({ charged: 0, failed: 1 });
    const failed = invoices(context, id);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['status']).toBe('recycling');
    expect(body(getSubscription(context, id))['status']).toBe('authorized');
    expect(nested(body(getSubscription(context, id)), 'summarized')['charged_quantity']).toBe(0);

    clock.advance(DAY);
    const repaired = context.store.documents.get('preapproval', id) as StoredDocument;
    context.store.documents.update({
      ...repaired,
      doc: { ...repaired.doc, auto_recurring: { ...(repaired.doc['auto_recurring'] as Loose), transaction_amount: 29.9 } } as never,
    });

    expect(runBilling(context, clock.now())).toEqual({ charged: 1, failed: 0 });
    const recycled = invoices(context, id);
    expect(recycled).toHaveLength(1);
    expect(recycled[0]?.['id']).toBe(failed[0]?.['id'] as number);
    expect(recycled[0]?.['status']).toBe('processed');
  });

  test('exposes invoices and emits the subscription topics', () => {
    const { context, events } = harness();
    const id = subscribe(context)['id'] as string;
    runBilling(context, START);

    const invoice = invoices(context, id)[0] as Loose;
    const fetched = body(getAuthorizedPayment(context, String(invoice['id'])));
    expect(fetched['preapproval_id']).toBe(id);
    expect(fetched['currency_id']).toBe('BRL');
    expect(getAuthorizedPayment(context, '404').ok).toBe(false);

    const byPayment = body(
      searchAuthorizedPayments(
        context,
        new URLSearchParams({ payment_id: String(nested(invoice, 'payment')['id']) }),
      ),
    );
    expect(list(byPayment)).toHaveLength(1);

    const byStatus = body(searchAuthorizedPayments(context, new URLSearchParams({ status: 'recycling' })));
    expect(list(byStatus)).toHaveLength(0);

    const byPayer = body(
      searchAuthorizedPayments(
        context,
        new URLSearchParams({ payer_id: String(body(getSubscription(context, id))['payer_id']) }),
      ),
    );
    expect(list(byPayer)).toHaveLength(1);

    expect(new Set(topics(events))).toEqual(
      new Set(['subscription_preapproval', 'payment', 'subscription_authorized_payment']),
    );
  });
});

/* Reference schedule, written independently of the implementation. */
function referenceDue(anchor: number, index: number, frequency: number, type: 'days' | 'months'): number {
  if (type === 'days') return anchor + index * frequency * DAY;
  const base = new Date(anchor);
  const target = base.getUTCMonth() + index * frequency;
  const year = base.getUTCFullYear() + Math.floor(target / 12);
  const month = ((target % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(base.getUTCDate(), last), 12);
}

describe('billing fuzz', () => {
  test('the number of charges always matches the schedule', () => {
    const random = new SeededRandom(20_240_110);

    for (let round = 0; round < 60; round++) {
      const type = random.int(2) === 0 ? 'days' : 'months';
      const frequency = 1 + random.int(type === 'days' ? 45 : 4);
      const repetitions = random.int(3) === 0 ? null : 1 + random.int(8);
      const startDay = 1 + random.int(28);
      const startMonth = random.int(12);
      const horizonDays = 30 + random.int(700);
      const startAt = Date.UTC(2024, startMonth, startDay, 12);
      const at = startAt + horizonDays * DAY;

      const { context } = harness(startAt);
      const id = subscribe(context, {
        frequency,
        frequency_type: type,
        transaction_amount: 5,
        ...(repetitions === null ? {} : { repetitions }),
      })['id'] as string;

      let expected = 0;
      while (referenceDue(startAt, expected, frequency, type) <= at) {
        if (repetitions !== null && expected >= repetitions) break;
        expected++;
      }

      const result = runBilling(context, at);
      expect({ round, ...result }).toEqual({ round, charged: expected, failed: 0 });
      expect(invoices(context, id)).toHaveLength(expected);
      expect(nested(body(getSubscription(context, id)), 'summarized')['charged_quantity']).toBe(expected);
    }
  });
});
