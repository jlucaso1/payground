import { afterEach, describe, expect, test } from 'bun:test';
import { ManualClock, SeededIdGenerator } from '@payground/core/testing.ts';
import { Storage } from '@payground/storage';
import { createServer } from './server.ts';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

function start() {
  const server = createServer({
    port: 0,
    clock: new ManualClock(1_700_000_000_000),
    storage: Storage.open(),
    ids: new SeededIdGenerator(),
    deliveryIntervalMs: 0,
    bootstrap: { accessToken: 'TEST-a', publicKey: 'TEST-p', webhookSecret: 's' },
  });
  close = async () => {
    await server.stop(true);
  };

  const create = async (methodCode: string, extra: Record<string, unknown> = {}) => {
    const response = await fetch(`${server.url.origin}/v1/payments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer TEST-a',
        'x-idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        transaction_amount: 50,
        payment_method_id: methodCode,
        payer: { email: 'a@b.c', identification: { type: 'CPF', number: '12345678909' } },
        ...extra,
      }),
    });
    return (await response.json()) as any;
  };

  return { origin: server.url.origin, create };
}

describe('ticket page', () => {
  test('a Pix ticket shows the QR image and the copy-and-paste code', async () => {
    const app = start();
    const payment = await app.create('pix');
    const response = await fetch(payment.transaction_details.external_resource_url);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('data:image/png;base64,');
    expect(html).toContain(payment.point_of_interaction.transaction_data.qr_code);
  });

  test('a boleto ticket shows the digitable line and a barcode', async () => {
    const app = start();
    const payment = await app.create('bolbradesco');
    const response = await fetch(payment.transaction_details.external_resource_url);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(payment.transaction_details.digitable_line);
    expect(html).toContain('<svg');
  });

  test('the ticket escapes payer supplied text', async () => {
    const app = start();
    const payment = await app.create('bolbradesco', { description: '</table><script>alert(1)</script>' });
    const html = await (await fetch(payment.transaction_details.external_resource_url)).text();

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('an unknown or non-ticket payment is a 404', async () => {
    const app = start();
    expect((await fetch(`${app.origin}/payments/999999/ticket`)).status).toBe(404);
    expect((await fetch(`${app.origin}/payments/not-a-number/ticket`)).status).toBe(404);

    const wallet = await app.create('account_money');
    expect((await fetch(`${app.origin}/payments/${wallet.id}/ticket`)).status).toBe(404);
  });
});
