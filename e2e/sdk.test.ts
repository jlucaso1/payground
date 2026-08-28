import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { type Harness, startHarness } from './harness.ts';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.stop();
});

describe('official SDK against payground', () => {
  test('reaches the emulator instead of the real API', async () => {
    const res = await fetch(`${harness.url}/_payground/health`);
    expect((await res.json()) as { status: string }).toMatchObject({ status: 'ok' });
  });

  test('an unknown resource surfaces as a typed SDK error', async () => {
    const client = new MercadoPagoConfig({ accessToken: 'TEST-access-token' });
    const promise = new Payment(client).get({ id: 404 });
    await expect(promise).rejects.toMatchObject({ status: 404, error: 'not_found' });
  });
});
