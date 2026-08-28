import { type Sandbox, sandboxId } from '@payground/core';
import { ManualClock, SeededIdGenerator } from '@payground/core/testing.ts';
import { Storage } from '@payground/storage';
import { type ServiceContext, noopSink } from './context.ts';

export interface Harness {
  context: ServiceContext;
  clock: ManualClock;
}

/** A live ServiceContext backed by an in-memory database, for the api tests. */
export function harness(now = 1_700_000_000_000): Harness {
  const clock = new ManualClock(now);
  const storage = Storage.open();
  const sandbox: Sandbox = {
    id: sandboxId('s-1'),
    name: 'test',
    accessToken: 'TEST-token',
    publicKey: 'TEST-public',
    webhookSecret: 'shh',
    liveMode: false,
    createdAt: now,
  };
  storage.sandboxes.create(sandbox);

  return {
    clock,
    context: {
      store: storage.forSandbox(sandbox.id),
      sandbox,
      clock,
      ids: new SeededIdGenerator(),
      baseUrl: 'http://127.0.0.1:8080',
      collectorId: 1_234_567,
      events: noopSink,
    },
  };
}

export const cardTokenBody = (overrides: Record<string, unknown> = {}) => ({
  card_number: '4235 6477 2802 5682',
  expiration_month: 11,
  expiration_year: 2030,
  security_code: '123',
  cardholder: { name: 'APRO', identification: { type: 'CPF', number: '12345678909' } },
  ...overrides,
});

export const cardPaymentBody = (token: string, overrides: Record<string, unknown> = {}) => ({
  transaction_amount: 100.5,
  token,
  installments: 1,
  payer: { email: 'payer@example.com', identification: { type: 'CPF', number: '12345678909' } },
  ...overrides,
});
