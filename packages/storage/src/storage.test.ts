import { afterEach, describe, expect, test } from 'bun:test';
import { paymentId, refundId, sandboxId, unwrap } from '@payground/core';
import { CARD, amount, input, payment } from '@payground/core/payment/fixture.ts';
import { apply, create } from '@payground/core';
import { Storage } from './index.ts';
import { sandbox, storageWith } from './fixture.ts';

let open: Storage[] = [];
const fresh = (...ids: string[]) => {
  const made = storageWith(...ids);
  open.push(made.storage);
  return made;
};
afterEach(() => {
  for (const s of open) s.close();
  open = [];
});

describe('migrations', () => {
  test('run once and are safe to re-run', () => {
    const { storage } = fresh();
    storage.migrate();
    storage.migrate();
    expect(storage.sandboxes.list()).toEqual([]);
  });
});

describe('sandbox registry', () => {
  test('finds a sandbox by either credential', () => {
    const { storage } = fresh('a');
    expect(storage.sandboxes.byAccessToken('TEST-a-access')?.id).toBe(sandboxId('a'));
    expect(storage.sandboxes.byPublicKey('TEST-a-public')?.id).toBe(sandboxId('a'));
    expect(storage.sandboxes.byAccessToken('TEST-a-public')).toBeNull();
    expect(storage.sandboxes.byAccessToken('nope')).toBeNull();
  });

  test('reset clears data but keeps the credentials', () => {
    const { storage } = fresh('a');
    const store = storage.forSandbox(sandboxId('a'));
    store.payments.insert({ ...payment(), sandbox: sandboxId('a') }, store.nextSequence('payment'));

    storage.sandboxes.reset(sandboxId('a'));

    expect(store.payments.search({}).total).toBe(0);
    expect(storage.sandboxes.get(sandboxId('a'))).not.toBeNull();
    expect(store.nextSequence('payment')).toBe(1);
  });

  test('removing a sandbox cascades to its data', () => {
    const { storage } = fresh('a');
    const store = storage.forSandbox(sandboxId('a'));
    store.payments.insert({ ...payment(), sandbox: sandboxId('a') }, 1);
    storage.sandboxes.remove(sandboxId('a'));
    expect(store.payments.get(payment().id)).toBeNull();
  });
});

describe('isolation', () => {
  test('a repository cannot see another sandbox', () => {
    const { storage } = fresh('a', 'b');
    const a = storage.forSandbox(sandboxId('a'));
    const b = storage.forSandbox(sandboxId('b'));
    const p = payment();

    a.payments.insert({ ...p, sandbox: sandboxId('a') }, 1);

    expect(a.payments.get(p.id)).not.toBeNull();
    expect(b.payments.get(p.id)).toBeNull();
    expect(b.payments.bySequence(1)).toBeNull();
    expect(b.payments.search({}).total).toBe(0);
  });

  test('the same id may exist independently in two sandboxes', () => {
    const { storage } = fresh('a', 'b');
    const p = payment();
    storage.forSandbox(sandboxId('a')).payments.insert({ ...p, sandbox: sandboxId('a') }, 1);
    storage.forSandbox(sandboxId('b')).payments.insert({ ...p, sandbox: sandboxId('b'), amount: amount(999) }, 1);

    expect(storage.forSandbox(sandboxId('a')).payments.get(p.id)?.amount).toBe(p.amount);
    expect(storage.forSandbox(sandboxId('b')).payments.get(p.id)?.amount).toBe(amount(999));
  });

  test('sequences advance independently per sandbox and scope', () => {
    const { storage } = fresh('a', 'b');
    const a = storage.forSandbox(sandboxId('a'));
    const b = storage.forSandbox(sandboxId('b'));
    expect([a.nextSequence('payment'), a.nextSequence('payment'), a.nextSequence('refund')]).toEqual([1, 2, 1]);
    expect(b.nextSequence('payment')).toBe(1);
  });

  test('a payment cannot be written for an unknown sandbox', () => {
    const { storage } = fresh('a');
    const store = storage.forSandbox(sandboxId('ghost'));
    expect(() => store.payments.insert({ ...payment(), sandbox: sandboxId('ghost') }, 1)).toThrow();
  });
});

describe('payments', () => {
  const setup = () => {
    const { storage } = fresh('a');
    const store = storage.forSandbox(sandboxId('a'));
    return { storage, store };
  };

  test('round trips every field', () => {
    const { store } = setup();
    const p = unwrap(
      create(
        input({
          sandbox: sandboxId('a'),
          method: CARD,
          description: 'a description',
          externalReference: 'ORDER-1',
          notificationUrl: 'https://example.com/hook',
          metadata: { nested: { list: [1, 'two', true, null] } },
          expiresAt: 90_000,
        }),
        { kind: 'authorize' },
        1_000,
      ),
    );
    store.payments.insert(p, 7);
    expect(store.payments.get(p.id)).toEqual(p);
    expect(store.payments.bySequence(7)).toEqual(p);
    expect(store.payments.sequenceOf(p.id)).toBe(7);
  });

  test('update persists the new status and amounts', () => {
    const { store } = setup();
    const p = { ...payment(), sandbox: sandboxId('a') };
    store.payments.insert(p, 1);
    const settled = unwrap(apply(p, { type: 'settle' }, 2_000)).payment;
    store.payments.update(settled);
    expect(store.payments.get(p.id)).toEqual(settled);
  });

  test('update refuses to touch a payment in another sandbox', () => {
    const { storage, store } = setup();
    store.payments.insert({ ...payment(), sandbox: sandboxId('a') }, 1);
    storage.sandboxes.create({ ...sandbox('c'), createdAt: 1 });
    expect(() =>
      storage.forSandbox(sandboxId('c')).payments.update({ ...payment(), sandbox: sandboxId('c') }),
    ).toThrow();
  });

  test('records and replays the timeline in order', () => {
    const { store } = setup();
    const p = { ...payment(), sandbox: sandboxId('a') };
    store.payments.insert(p, 1);
    const settled = unwrap(apply(p, { type: 'settle' }, 2_000));
    store.payments.record(settled);
    store.payments.update(settled.payment);
    const refunded = unwrap(apply(settled.payment, { type: 'refund', amount: amount(10_000) }, 3_000));
    store.payments.record(refunded);
    store.payments.update(refunded.payment);

    const timeline = store.payments.timeline(p.id);
    expect(timeline.map((t) => [t.from.state, t.to.state, t.at])).toEqual([
      ['pending', 'succeeded', 2_000],
      ['succeeded', 'refunded', 3_000],
    ]);
    expect(timeline[1]?.command).toEqual({ type: 'refund', amount: amount(10_000) });
  });

  test('timeline of an unknown payment is empty', () => {
    const { store } = setup();
    expect(store.payments.timeline(paymentId('nope'))).toEqual([]);
  });
});

describe('refunds', () => {
  test('round trip and listing by payment', () => {
    const { storage } = fresh('a');
    const store = storage.forSandbox(sandboxId('a'));
    const p = { ...payment({ kind: 'settle' }), sandbox: sandboxId('a') };
    store.payments.insert(p, 1);

    const refund = {
      id: refundId('r-1'),
      sandbox: sandboxId('a'),
      paymentId: p.id,
      amount: amount(2_500),
      status: 'approved' as const,
      partial: true,
      createdAt: 4_000,
    };
    store.refunds.insert(refund, 1);

    expect(store.refunds.get(refund.id)).toEqual(refund);
    expect(store.refunds.bySequence(1)).toEqual(refund);
    expect(store.refunds.sequenceOf(refund.id)).toBe(1);
    expect(store.refunds.listFor(p.id)).toEqual([refund]);
    expect(store.refunds.listFor(paymentId('other'))).toEqual([]);
  });
});

describe('idempotency store', () => {
  test('stores, reads back and purges by age', () => {
    const { storage } = fresh('a');
    const store = storage.forSandbox(sandboxId('a'));
    const record = { key: 'k1', fingerprint: 'f', status: 201, body: '{}', createdAt: 1_000 };
    store.idempotency.put(record);

    expect(store.idempotency.get('k1')).toEqual(record);
    expect(store.idempotency.get('missing')).toBeNull();
    expect(store.idempotency.purgeBefore(500)).toBe(0);
    expect(store.idempotency.purgeBefore(1_001)).toBe(1);
    expect(store.idempotency.get('k1')).toBeNull();
  });

  test('the same key in two sandboxes does not collide', () => {
    const { storage } = fresh('a', 'b');
    const record = { key: 'same', fingerprint: 'f', status: 201, body: '{"a":1}', createdAt: 1 };
    storage.forSandbox(sandboxId('a')).idempotency.put(record);
    storage.forSandbox(sandboxId('b')).idempotency.put({ ...record, body: '{"b":2}' });
    expect(storage.forSandbox(sandboxId('a')).idempotency.get('same')?.body).toBe('{"a":1}');
    expect(storage.forSandbox(sandboxId('b')).idempotency.get('same')?.body).toBe('{"b":2}');
  });
});

describe('audit log', () => {
  test('records, filters and purges', () => {
    const { storage } = fresh('a');
    const entry = (id: string, at: number, action: string, sandbox: string | null) => ({
      id,
      at,
      actor: sandbox === null ? ({ kind: 'admin' } as const) : ({ kind: 'sandbox', sandbox: sandboxId(sandbox) } as const),
      action,
      target: `payment:${id}`,
      sandbox: sandbox === null ? null : sandboxId(sandbox),
      detail: { note: id },
    });

    storage.audit.record(entry('1', 1_000, 'sandbox.created', null));
    storage.audit.record(entry('2', 2_000, 'payment.settled', 'a'));
    storage.audit.record(entry('3', 3_000, 'payment.settled', 'a'));

    expect(storage.audit.search({}).total).toBe(3);
    expect(storage.audit.search({}).results.map((e) => e.id)).toEqual(['3', '2', '1']);
    expect(storage.audit.search({ action: 'payment.settled' }).total).toBe(2);
    expect(storage.audit.search({ sandbox: sandboxId('a') }).total).toBe(2);
    expect(storage.audit.search({ from: 2_000, to: 2_999 }).results.map((e) => e.id)).toEqual(['2']);
    expect(storage.audit.search({ limit: 1 }).results).toHaveLength(1);
    expect(storage.audit.search({})?.results[0]?.actor).toEqual({ kind: 'sandbox', sandbox: sandboxId('a') });
    expect(storage.audit.search({})?.results[2]?.actor).toEqual({ kind: 'admin' });

    expect(storage.audit.purgeBefore(2_500)).toBe(2);
    expect(storage.audit.search({}).total).toBe(1);
  });
});

describe('api request log', () => {
  const entry = (id: string, at: number, status: number, sandbox: string | null) => ({
    id,
    at,
    sandbox: sandbox === null ? null : sandboxId(sandbox),
    method: 'POST',
    route: '/v1/payments',
    path: '/v1/payments',
    status,
    durationMs: 12,
    requestBody: '{"a":1}',
    responseBody: '{"b":2}',
    idempotencyKey: 'k',
    userAgent: 'sdk',
  });

  test('round trips and filters by status band', () => {
    const { storage } = fresh('a');
    storage.requests.record(entry('1', 1_000, 201, 'a'));
    storage.requests.record(entry('2', 2_000, 400, 'a'));
    storage.requests.record(entry('3', 3_000, 500, null));

    expect(storage.requests.get('1')).toEqual(entry('1', 1_000, 201, 'a'));
    expect(storage.requests.get('missing')).toBeNull();
    expect(storage.requests.search({ minStatus: 400 }).total).toBe(2);
    expect(storage.requests.search({ status: 500 }).results.map((e) => e.id)).toEqual(['3']);
    expect(storage.requests.search({ sandbox: sandboxId('a') }).total).toBe(2);
    expect(storage.requests.search({ route: '/v1/payments' }).total).toBe(3);
    expect(storage.requests.search({ method: 'GET' }).total).toBe(0);
    expect(storage.requests.purgeBefore(2_500)).toBe(2);
    expect(storage.requests.search({}).total).toBe(1);
  });
});
