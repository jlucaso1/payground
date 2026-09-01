import { afterEach, describe, expect, test } from 'bun:test';
import { startReceiver, startTestServer } from '../testing.ts';

let stop: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of stop) await close();
  stop = [];
});

const DAY = 86_400_000;

function start() {
  const server = startTestServer();
  stop.push(server.stop);
  return server;
}

const subscribe = (server: ReturnType<typeof start>, notificationUrl?: string) =>
  server.api('POST', '/preapproval', {
    body: {
      reason: 'Monthly',
      payer_email: 'payer@example.com',
      card_token_id: 'card-token-1',
      auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: 29.9, currency_id: 'BRL' },
      ...(notificationUrl === undefined ? {} : { notification_url: notificationUrl }),
    },
  });

describe('billing over HTTP', () => {
  test('an external caller can charge a subscription without touching the clock', async () => {
    const server = start();
    const created = await subscribe(server);
    expect(created.status).toBe(201);

    const at = server.clock.now() + 40 * DAY;
    const run = await server.control('POST', `/_payground/sandboxes/${server.sandboxId}/billing/run?at=${at}`);
    expect(run.status).toBe(200);
    expect(run.body).toEqual({ at, charged: 2, failed: 0 });

    const invoices = await server.api('GET', `/authorized_payments?preapproval_id=${created.body.id}`);
    expect(invoices.body.paging.total).toBe(2);
  });

  test('running again at the same instant charges nothing more', async () => {
    const server = start();
    await subscribe(server);
    const path = `/_payground/sandboxes/${server.sandboxId}/billing/run?at=${server.clock.now() + DAY}`;
    expect((await server.control('POST', path)).body.charged).toBe(1);
    expect((await server.control('POST', path)).body.charged).toBe(0);
  });

  test('the run delivers the subscription topics to the notification_url', async () => {
    const server = start();
    const receiver = startReceiver();
    stop.push(receiver.stop);

    await subscribe(server, receiver.url);
    await server.control('POST', `/_payground/sandboxes/${server.sandboxId}/billing/run?at=${server.clock.now()}`);
    await server.control('POST', '/_payground/webhooks/drain');

    const topics = receiver.received.map((call) => (call.body as { type: string }).type);
    expect(topics).toContain('subscription_preapproval');
    expect(topics).toContain('subscription_authorized_payment');
    expect(topics).toContain('payment');
  });

  test('a bad instant, an unknown sandbox and a missing token are all refused', async () => {
    const server = start();
    const base = `/_payground/sandboxes/${server.sandboxId}/billing/run`;
    expect((await server.control('POST', `${base}?at=nope`)).status).toBe(400);
    expect((await server.control('POST', `${base}?at=-1`)).status).toBe(400);
    expect((await server.control('POST', '/_payground/sandboxes/00000000-0000-4000-8000-000000000000/billing/run')).status).toBe(404);
    expect((await server.control('POST', base, undefined, null)).status).toBe(401);
  });

  test('the run is audited', async () => {
    const server = start();
    await server.control('POST', `/_payground/sandboxes/${server.sandboxId}/billing/run`);
    const audit = await server.control('GET', '/_payground/audit');
    expect((audit.body.results as { action: string }[]).map((entry) => entry.action)).toContain('billing.run');
  });
});

describe('webhook drain over HTTP', () => {
  test('draining delivers what is queued and reports the count', async () => {
    const server = start();
    const receiver = startReceiver();
    stop.push(receiver.stop);

    await server.api('POST', '/v1/payments', {
      body: {
        transaction_amount: 10,
        payment_method_id: 'pix',
        payer: { email: 'a@b.c' },
        notification_url: receiver.url,
      },
    });

    const drained = await server.control('POST', '/_payground/webhooks/drain');
    expect(drained.status).toBe(200);
    expect(drained.body.delivered).toBeGreaterThan(0);
    expect(receiver.received).toHaveLength(drained.body.delivered);

    expect((await server.control('POST', '/_payground/webhooks/drain')).body.delivered).toBe(0);
  });

  test('draining needs the admin token', async () => {
    const server = start();
    expect((await server.control('POST', '/_payground/webhooks/drain', undefined, null)).status).toBe(401);
  });
});
