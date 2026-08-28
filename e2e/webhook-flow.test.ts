import { afterEach, describe, expect, test } from 'bun:test';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { WebhookSignatureValidator } from 'mercadopago/dist/utils/webhook';
import { createServer } from '@payground/server';

interface Delivered {
  headers: Record<string, string>;
  body: { type: string; action: string; data: { id: string } };
}

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
      delivered.push({
        headers: Object.fromEntries(request.headers.entries()),
        body: (await request.json()) as Delivered['body'],
      });
      return new Response('ok');
    },
  });

  const server = createServer({ port: 0, deliveryIntervalMs: 0 });
  const sandbox = server.app.defaultSandbox;
  if (sandbox === null) throw new Error('expected a bootstrapped sandbox');

  const { AppConfig } = (await import('mercadopago/dist/utils/config')) as { AppConfig: { BASE_URL: string } };
  AppConfig.BASE_URL = server.url.origin;

  teardown = async () => {
    await server.stop(true);
    await receiver.stop(true);
  };

  const control = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${server.url.origin}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return (await response.json()) as any;
  };

  return {
    sandbox,
    delivered,
    hook: `${receiver.url.origin}/hook`,
    payments: new Payment(new MercadoPagoConfig({ accessToken: sandbox.accessToken })),
    control,
    drain: () => server.app.drainWebhooks(),
  };
}

describe('a Pix approved from the dashboard reaches the integrator', () => {
  test('the whole loop, with a signature the official validator accepts', async () => {
    const app = await scenario();

    const created = await app.payments.create({
      body: {
        transaction_amount: 250.75,
        payment_method_id: 'pix',
        description: 'End to end',
        notification_url: app.hook,
        external_reference: 'ORDER-99',
        payer: { email: 'buyer@example.com', identification: { type: 'CPF', number: '12345678909' } },
      },
    });

    expect(created.status).toBe('pending');
    expect(created.point_of_interaction?.transaction_data?.qr_code).toStartWith('000201');

    await app.drain();
    expect(app.delivered).toHaveLength(1);
    expect(app.delivered[0]?.body).toMatchObject({
      type: 'payment',
      action: 'payment.created',
      data: { id: String(created.id) },
    });

    const list = await app.control('GET', `/_payground/sandboxes/${app.sandbox.id}/payments`);
    const internalId = list.results[0].id;
    const acted = await app.control(
      'POST',
      `/_payground/sandboxes/${app.sandbox.id}/payments/${internalId}/actions`,
      { type: 'settle' },
    );
    expect(acted.payment.state).toBe('succeeded');

    await app.drain();
    expect(app.delivered).toHaveLength(2);
    const update = app.delivered[1] as Delivered;
    expect(update.body.action).toBe('payment.updated');

    // The integrator validates with its unmodified production code.
    expect(() =>
      WebhookSignatureValidator.validate({
        xSignature: update.headers['x-signature'],
        xRequestId: update.headers['x-request-id'],
        dataId: update.body.data.id,
        secret: app.sandbox.webhookSecret,
      }),
    ).not.toThrow();

    expect(() =>
      WebhookSignatureValidator.validate({
        xSignature: update.headers['x-signature'],
        xRequestId: update.headers['x-request-id'],
        dataId: update.body.data.id,
        secret: 'the-wrong-secret',
      }),
    ).toThrow();

    const reread = await app.payments.get({ id: created.id as number });
    expect(reread.status).toBe('approved');
    expect(reread.status_detail).toBe('accredited');
  });

  test('a failing endpoint is retried and shows up in the delivery log', async () => {
    const app = await scenario();
    const failing = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('no', { status: 500 }) });

    try {
      await app.payments.create({
        body: {
          transaction_amount: 10,
          payment_method_id: 'pix',
          notification_url: `${failing.url.origin}/hook`,
          payer: { email: 'buyer@example.com' },
        },
      });

      await app.drain();
      const log = await app.control('GET', `/_payground/sandboxes/${app.sandbox.id}/webhooks`);
      expect(log[0]).toMatchObject({ status: 'retrying', attempts: 1, lastStatusCode: 500 });
      expect(log[0].nextAttemptAt).toBeGreaterThan(log[0].createdAt);
      expect(log[0].history).toHaveLength(1);
    } finally {
      await failing.stop(true);
    }
  });
});
