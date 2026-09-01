import { describe, expect, test } from 'bun:test';
import type { ApiRequestEntry } from '@payground/core';
import type { ParityReport } from '@payground/server/parity/report.ts';
import { main } from '../index.ts';
import { testEnv } from '../testing.ts';

const call = (overrides: Partial<ApiRequestEntry>): ApiRequestEntry => ({
  id: crypto.randomUUID(),
  at: 1_700_000_000_000,
  sandbox: null,
  method: 'POST',
  route: '/v1/payments',
  path: '/v1/payments',
  status: 201,
  durationMs: 3,
  requestBody: JSON.stringify({ transaction_amount: 10, payment_method_id: 'pix', payer: { email: 'a@b.c' } }),
  responseBody: null,
  idempotencyKey: null,
  userAgent: null,
  ...overrides,
});

describe('doctor', () => {
  test('an empty history is not blocking', async () => {
    const { env, out } = testEnv();
    expect(await main(['doctor', '--db', ':memory:'], env)).toBe(0);
    expect(out.join('\n')).toContain('nothing blocking');
  });

  test('reports the operations used and clears a conforming integration', async () => {
    const { env, storage, out } = testEnv();
    storage.requests.record(call({}));
    expect(await main(['doctor', '--db', ':memory:'], env)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('createPayment');
    expect(text).toContain('emulated (payments)');
    expect(text).toContain('nothing blocking');
  });

  test('flags a body the real API would reject and exits non-zero', async () => {
    const { env, storage, out } = testEnv();
    storage.requests.record(
      call({
        requestBody: JSON.stringify({
          transaction_amount: 10,
          payment_method_id: 'pix',
          payer: { email: 'a@b.c' },
          not_a_real_field: 1,
        }),
      }),
    );
    expect(await main(['doctor', '--db', ':memory:'], env)).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('Requests the real API would reject');
    expect(text).toContain('not_a_real_field');
    expect(text).toContain('https://api.mercadopago.com');
  });

  test('names the operation behind every recorded route', async () => {
    const { env, storage, out } = testEnv();
    storage.requests.record(call({ route: '/merchant_orders', path: '/merchant_orders', requestBody: null }));
    expect(await main(['doctor', '--db', ':memory:'], env)).toBe(0);
    expect(out.join('\n')).toContain('createMerchantOrder');
  });

  test('emits the same report as json', async () => {
    const { env, storage, out } = testEnv();
    storage.requests.record(call({}));
    expect(await main(['doctor', '--db', ':memory:', '--format', 'json'], env)).toBe(0);
    const report = JSON.parse(out.join('\n')) as ParityReport;
    expect(report.operations[0]?.operationId).toBe('createPayment');
    expect(report.verdict.blocking).toBe(false);
  });

  test('an unknown sandbox is a failure, an unknown format is bad usage', async () => {
    const { env, err } = testEnv();
    expect(await main(['doctor', '--db', ':memory:', '--sandbox', 'nope'], env)).toBe(1);
    expect(err.join('\n')).toContain('sandbox not found');
    expect(await main(['doctor', '--db', ':memory:', '--format', 'yaml'], env)).toBe(2);
  });

  test('a database that was never written is a failure, not a clean report', async () => {
    const { env, err } = testEnv();
    expect(await main(['doctor', '--db', '/tmp/payground-doctor-missing.sqlite'], env)).toBe(1);
    expect(err.join('\n')).toContain('no database at');
  });

  test('help is documented', async () => {
    const { env, out } = testEnv();
    expect(await main(['doctor', '--help'], env)).toBe(0);
    expect(out.join('\n')).toContain('--sandbox');
  });
});
