import { afterEach, describe, expect, test } from 'bun:test';
import { Invoice, MercadoPagoConfig, PreApproval, PreApprovalPlan } from 'mercadopago';
import type { PreApprovalRequest } from 'mercadopago/dist/clients/preApproval/commonTypes';
import { createServer } from '@payground/server';

interface Delivered {
  type: string;
  action: string;
  data: { id: string };
}

const DAY = 86_400_000;
const ADMIN = 'e2e-admin-token';

let teardown: (() => Promise<void>) | null = null;
afterEach(async () => {
  await teardown?.();
  teardown = null;
});

async function scenario() {
  const delivered: Delivered[] = [];
  const receiver = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      delivered.push((await request.json()) as Delivered);
      return new Response('ok');
    },
  });

  const server = createServer({ port: 0, deliveryIntervalMs: 0, adminToken: ADMIN });
  const sandbox = server.app.defaultSandbox;
  if (sandbox === null) throw new Error('expected a bootstrapped sandbox');

  const { AppConfig } = (await import('mercadopago/dist/utils/config')) as { AppConfig: { BASE_URL: string } };
  AppConfig.BASE_URL = server.url.origin;

  teardown = async () => {
    await server.stop(true);
    await receiver.stop(true);
  };

  /** Everything below goes over HTTP with the admin token, the way an external suite would. */
  const control = async (path: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`${server.url.origin}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  };

  const config = new MercadoPagoConfig({ accessToken: sandbox.accessToken });
  return {
    delivered,
    hook: `${receiver.url.origin}/hook`,
    plans: new PreApprovalPlan(config),
    subscriptions: new PreApproval(config),
    invoices: new Invoice(config),
    bill: (at: number) => control(`/_payground/sandboxes/${sandbox.id}/billing/run?at=${at}`),
    drain: () => control('/_payground/webhooks/drain'),
  };
}

const monthly = (amount: number) => ({
  frequency: 1,
  frequency_type: 'months',
  transaction_amount: amount,
  currency_id: 'BRL',
});

describe('subscriptions through the official SDK', () => {
  test('a plan, a subscription and two billing cycles, all driven over HTTP', async () => {
    const scene = await scenario();

    const plan = await scene.plans.create({
      body: { reason: 'Premium', auto_recurring: monthly(29.9), back_url: 'https://merchant.test/back' },
    });
    expect(plan.id).toBeString();

    const planId = plan.id;
    if (planId === undefined) throw new Error('expected a plan id');

    const body: PreApprovalRequest & { notification_url: string } = {
      preapproval_plan_id: planId,
      reason: 'Premium',
      payer_email: 'payer@example.com',
      card_token_id: 'card-token-1',
      auto_recurring: monthly(29.9),
      notification_url: scene.hook,
    };
    const subscription = await scene.subscriptions.create({ body });
    expect(subscription.status).toBe('authorized');

    const id = subscription.id;
    if (id === undefined) throw new Error('expected a subscription id');

    const billed = await scene.bill(Date.now() + 40 * DAY);
    expect(billed['charged']).toBe(2);
    expect(billed['failed']).toBe(0);

    const found = await scene.invoices.search({ options: { preapproval_id: id } });
    expect(found.paging?.total).toBe(2);
    expect(found.results?.[0]?.status).toBe('processed');

    const after = await scene.subscriptions.get({ id });
    expect(after.summarized?.charged_quantity).toBe(2);
    expect(after.summarized?.charged_amount).toBe(59.8);

    const drained = await scene.drain();
    expect(drained['delivered']).toBe(scene.delivered.length);
    const topics = new Set(scene.delivered.map((notice) => notice.type));
    expect(topics).toContain('subscription_preapproval');
    expect(topics).toContain('subscription_authorized_payment');
    expect(topics).toContain('payment');
  });

  test('pausing stops the charges and resuming picks them up again', async () => {
    const scene = await scenario();
    const body: PreApprovalRequest & { notification_url: string } = {
      reason: 'Premium',
      payer_email: 'payer@example.com',
      card_token_id: 'card-token-1',
      auto_recurring: monthly(10),
      notification_url: scene.hook,
    };
    const created = await scene.subscriptions.create({ body });
    const id = created.id;
    if (id === undefined) throw new Error('expected a subscription id');

    expect((await scene.bill(Date.now()))['charged']).toBe(1);

    const paused = await scene.subscriptions.update({ id, body: { status: 'paused' } });
    expect(paused.status).toBe('paused');
    expect((await scene.bill(Date.now() + 60 * DAY))['charged']).toBe(0);

    const resumed = await scene.subscriptions.update({ id, body: { status: 'authorized' } });
    expect(resumed.status).toBe('authorized');
    expect((await scene.bill(Date.now() + 120 * DAY))['charged']).toBeGreaterThan(0);

    const cancelled = await scene.subscriptions.update({ id, body: { status: 'cancelled' } });
    expect(cancelled.status).toBe('cancelled');
    expect((await scene.bill(Date.now() + 365 * DAY))['charged']).toBe(0);
  });
});
