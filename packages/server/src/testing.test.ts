import { afterEach, describe, expect, test } from 'bun:test';
import { TEST_ADMIN_TOKEN, type TestServer, startReceiver, startTestServer } from './testing.ts';

let app: TestServer | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

const pix = { transaction_amount: 100, payment_method_id: 'pix', payer: { email: 'a@b.c' } };

describe('test harness', () => {
  test('boots a sandbox and reaches the emulated API', async () => {
    app = startTestServer();
    const created = await app.api('POST', '/v1/payments', { body: pix });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('pending');
    expect(app.sandboxId).not.toBe('');
  });

  test('the control API needs the admin token the harness knows', async () => {
    app = startTestServer();
    expect((await app.control('GET', '/_payground/sandboxes')).status).toBe(200);
    expect((await app.control('GET', '/_payground/sandboxes', undefined, null)).status).toBe(401);
    expect((await app.control('GET', '/_payground/sandboxes', undefined, 'wrong')).status).toBe(401);
    expect(TEST_ADMIN_TOKEN).not.toBe('');
  });

  test('time only moves when the test moves it', async () => {
    app = startTestServer();
    const before = app.clock.now();
    await app.api('GET', '/v1/payments/search');
    expect(app.clock.now()).toBe(before);
    app.clock.advance(1_000);
    expect(app.clock.now()).toBe(before + 1_000);
  });

  test('webhooks are delivered only when the test drains them', async () => {
    app = startTestServer();
    const receiver = startReceiver();
    try {
      await app.api('POST', '/v1/payments', { body: { ...pix, notification_url: receiver.url } });
      expect(receiver.received).toHaveLength(0);

      expect(await app.drainWebhooks()).toBe(1);
      expect(receiver.received).toHaveLength(1);
      expect(receiver.received[0]?.headers['x-signature']).toMatch(/^ts=\d+,v1=[0-9a-f]{64}$/);
    } finally {
      await receiver.stop();
    }
  });

  test('non-JSON responses come back as text instead of throwing', async () => {
    app = startTestServer();
    const created = await app.api('POST', '/v1/payments', { body: pix });
    const ticket = await app.api('GET', `/payments/${created.body.id}/ticket`);
    expect(ticket.status).toBe(200);
    expect(typeof ticket.body).toBe('string');
  });
});
