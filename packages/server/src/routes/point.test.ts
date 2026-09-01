import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type TestServer, startTestServer } from '../testing.ts';

let server: TestServer;

beforeAll(() => {
  server = startTestServer();
});
afterAll(async () => {
  await server.stop();
});

const PDV = 'PAX_A910__SMARTPOS1471016179';

const drive = (id: string, command: string) =>
  server.control('POST', `/_payground/sandboxes/${server.sandboxId}/point/intents/${id}/actions`, {
    command,
  });

describe('point over http', () => {
  test('lists devices and terminals', async () => {
    const devices = await server.api('GET', '/point/integration-api/devices');
    expect(devices.status).toBe(200);
    expect(devices.body.devices[0].id).toBe(PDV);

    const terminals = await server.api('GET', '/terminals/v1/list');
    expect(terminals.status).toBe(200);
    expect(terminals.body.data.terminals.length).toBe(3);
  });

  test('drives an intent to a payment visible on /v1/payments', async () => {
    const created = await server.api('POST', `/point/integration-api/devices/${PDV}/payment-intents`, {
      body: { amount: 2500, description: 'Point sale', additional_info: { external_reference: 'http-1' } },
    });
    expect(created.status).toBe(201);
    expect(created.body.state).toBe('OPEN');

    for (const command of ['deliver', 'process', 'finish']) {
      expect((await drive(created.body.id, command)).status).toBe(200);
    }

    const intent = await server.api('GET', `/point/integration-api/payment-intents/${created.body.id}`);
    expect(intent.body.state).toBe('FINISHED');

    const payment = await server.api('GET', `/v1/payments/${intent.body.payment.id}`);
    expect(payment.status).toBe(200);
    expect([payment.body.status, payment.body.transaction_amount]).toEqual(['approved', 25]);
  });

  test('refunds through a refund intent', async () => {
    const created = await server.api('POST', `/point/integration-api/devices/${PDV}/payment-intents`, {
      body: { amount: 1000 },
    });
    for (const command of ['deliver', 'process', 'finish']) await drive(created.body.id, command);
    const intent = await server.api('GET', `/point/integration-api/payment-intents/${created.body.id}`);

    const refund = await server.api('POST', `/point/integration-api/devices/${PDV}/refund`, {
      body: { payment_id: intent.body.payment.id },
    });
    expect(refund.status).toBe(200);
    expect(refund.body.status).toBe('open');

    for (const command of ['deliver', 'process', 'finish']) await drive(refund.body.id, command);
    const settled = await server.api('GET', `/point/integration-api/refund/${refund.body.id}`);
    expect(settled.body.status).toBe('finished');

    const payment = await server.api('GET', `/v1/payments/${intent.body.payment.id}`);
    expect(payment.body.status).toBe('refunded');
  });

  test('cancels an open intent and rejects a second cancellation', async () => {
    const created = await server.api('POST', `/point/integration-api/devices/${PDV}/payment-intents`, {
      body: { amount: 700 },
    });
    const path = `/point/integration-api/devices/${PDV}/payment-intents/${created.body.id}`;
    expect((await server.api('DELETE', path)).status).toBe(200);
    expect((await server.api('DELETE', path)).status).toBe(409);
  });

  test('switches operating mode through /terminals/v1/setup', async () => {
    const standalone = 'PAX_A910__SMARTPOS1471016181';
    const updated = await server.api('PATCH', '/terminals/v1/setup', {
      body: { terminals: [{ id: standalone, operating_mode: 'PDV' }] },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.terminals[0].operating_mode).toBe('PDV');

    const back = await server.api('PATCH', '/terminals/v1/setup', {
      body: { terminals: [{ id: standalone, operating_mode: 'STANDALONE' }] },
    });
    expect(back.body.data.terminals[0].operating_mode).toBe('STANDALONE');
  });

  test('creates, reads and cancels a terminal action', async () => {
    const created = await server.api('POST', '/terminals/v1/actions', {
      body: {
        type: 'PRINT_INFO',
        external_reference: 'job-http',
        config: { device_id: PDV },
        content: { source: 'https://example.test/a.png' },
      },
    });
    expect(created.status).toBe(200);
    expect(created.body.status).toBe('pending');

    const found = await server.api('GET', `/terminals/v1/actions/${created.body.id}`);
    expect(found.body.terminal_id).toBe(PDV);

    const cancelled = await server.api('POST', `/terminals/v1/actions/${created.body.id}/cancel`);
    expect(cancelled.body.status).toBe('canceled');
    expect((await server.api('POST', `/terminals/v1/actions/${created.body.id}/cancel`)).status).toBe(409);
  });

  test('requires the admin token to act as the reader', async () => {
    const created = await server.api('POST', `/point/integration-api/devices/${PDV}/payment-intents`, {
      body: { amount: 300 },
    });
    const denied = await server.control(
      'POST',
      `/_payground/sandboxes/${server.sandboxId}/point/intents/${created.body.id}/actions`,
      { command: 'deliver' },
      null,
    );
    expect(denied.status).toBe(401);
    await server.api('DELETE', `/point/integration-api/devices/${PDV}/payment-intents/${created.body.id}`);
  });

  test('unknown sandbox and unknown intent are 404', async () => {
    const missing = await server.control('POST', '/_payground/sandboxes/nope/point/intents/x/actions', {
      command: 'deliver',
    });
    expect(missing.status).toBe(404);
    expect((await drive('unknown', 'deliver')).status).toBe(404);
  });
});
