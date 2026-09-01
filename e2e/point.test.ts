import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MercadoPagoConfig, Payment, Point } from 'mercadopago';
import { type Harness, startHarness } from './harness.ts';

let harness: Harness;
let point: Point;
let payments: Payment;

beforeAll(async () => {
  harness = await startHarness();
  const config = new MercadoPagoConfig({ accessToken: harness.sandbox.accessToken });
  point = new Point(config);
  payments = new Payment(config);
});
afterAll(async () => {
  await harness.stop();
});

/** The control API stands in for the card reader, which a test cannot physically tap. */
const drive = async (intentId: string, command: string): Promise<number> => {
  const response = await fetch(
    `${harness.url}/_payground/sandboxes/${harness.sandbox.id}/point/intents/${intentId}/actions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command }),
    },
  );
  return response.status;
};

/**
 * The SDK's `Device` type is a copy of the payment-intent event shape: it declares
 * `payment_intent_id`, `status` and `created_on`, none of which the endpoint returns.
 * https://github.com/mercadopago/sdk-nodejs — dist/clients/point/commonTypes.d.ts
 */
const firstDeviceId = async (): Promise<string> => {
  const listed = await point.getDevices({ request: {} });
  const device = listed.devices?.[0] as unknown as { id?: string } | undefined;
  if (device?.id === undefined) throw new Error('expected a seeded device');
  return device.id;
};

describe('the official Point client against payground', () => {
  test('lists the seeded devices', async () => {
    const listed = await point.getDevices({ request: {} });
    expect(listed.devices?.length).toBe(3);
    expect(await firstDeviceId()).toStartWith('PAX_A910__SMARTPOS');
    expect(listed.paging?.total).toBe(3);
  });

  test('drives a payment intent to FINISHED and the payment appears on the Payment client', async () => {
    const deviceId = await firstDeviceId();

    const created = await point.createPaymentIntent({
      device_id: deviceId,
      request: {
        amount: 3500,
        description: 'Point e2e',
        additional_info: { external_reference: 'point-e2e', print_on_terminal: true },
      },
    });
    expect(created.state).toBe('OPEN');
    expect(created.amount).toBe(3500);
    expect(created.device_id).toBe(deviceId);

    const intentId = created.id as string;
    for (const command of ['deliver', 'process', 'finish']) {
      expect(await drive(intentId, command)).toBe(200);
    }

    const finished = await point.searchPaymentIntent({ payment_intent_id: intentId });
    expect(finished.state).toBe('FINISHED');

    const paymentId = (finished.payment as { id?: number } | undefined)?.id as number;
    expect(typeof paymentId).toBe('number');

    const payment = await payments.get({ id: paymentId });
    expect(payment.status).toBe('approved');
    expect(payment.transaction_amount).toBe(35);
    expect(payment.description).toBe('Point e2e');
    expect(payment.external_reference).toBe('point-e2e');

    const searched = await payments.search({ options: { external_reference: 'point-e2e' } });
    expect(searched.results?.length).toBe(1);
  });

  test('cancels an open intent', async () => {
    const deviceId = await firstDeviceId();

    const created = await point.createPaymentIntent({
      device_id: deviceId,
      request: { amount: 1200 },
    });
    const cancelled = await point.cancelPaymentIntent({
      device_id: deviceId,
      payment_intent_id: created.id as string,
    });
    expect(cancelled.id).toBe(created.id as string);

    const found = await point.searchPaymentIntent({ payment_intent_id: created.id as string });
    expect(found.state).toBe('CANCELED');
  });
});
