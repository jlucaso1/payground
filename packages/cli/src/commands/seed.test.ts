import { describe, expect, test } from 'bun:test';
import type { Payment } from '@payground/core';
import { main } from '../index.ts';
import { testEnv } from '../testing.ts';

const payments = (storage: ReturnType<typeof testEnv>['storage']): readonly Payment[] => {
  const sandbox = storage.sandboxes.list()[0];
  if (sandbox === undefined) return [];
  return storage.forSandbox(sandbox.id).payments.search({ limit: 500 }).results;
};

describe('seed', () => {
  test('writes twelve payments and bootstraps a sandbox', async () => {
    const { env, storage, out } = testEnv();
    expect(await main(['seed'], env)).toBe(0);
    expect(storage.sandboxes.list()).toHaveLength(1);
    expect(payments(storage)).toHaveLength(12);
    expect(out[0]).toContain('seeded 12 payments');
  });

  test('covers every payment state with enough payments', async () => {
    const { env, storage } = testEnv();
    expect(await main(['seed', '--payments', '18'], env)).toBe(0);
    const states = new Set(payments(storage).map((payment) => payment.status.state));
    expect(states).toEqual(
      new Set(['pending', 'authorized', 'in_review', 'succeeded', 'failed', 'cancelled', 'refunded', 'in_mediation', 'charged_back']),
    );
  });

  test('records refunds for the refunded payments', async () => {
    const { env, storage } = testEnv();
    expect(await main(['seed', '--payments', '12'], env)).toBe(0);
    const sandbox = storage.sandboxes.list()[0];
    if (sandbox === undefined) throw new Error('expected a sandbox');
    const store = storage.forSandbox(sandbox.id);
    const refunded = payments(storage).filter((payment) => payment.refundedAmount > 0);
    expect(refunded.length).toBeGreaterThan(0);
    for (const payment of refunded) expect(store.refunds.listFor(payment.id)).not.toHaveLength(0);
  });

  test('is deterministic for a given seed', async () => {
    const fingerprint = async (seed: string): Promise<string> => {
      const { env, storage } = testEnv();
      expect(await main(['seed', '--seed', seed], env)).toBe(0);
      return JSON.stringify(
        payments(storage).map((payment) => [payment.id, payment.amount, payment.status, payment.method.code, payment.payer.email]),
      );
    };
    expect(await fingerprint('42')).toBe(await fingerprint('42'));
    expect(await fingerprint('42')).not.toBe(await fingerprint('43'));
  });

  test('reuses the existing sandbox', async () => {
    const { env, storage } = testEnv();
    expect(await main(['sandbox', 'create', '--name', 'acme'], env)).toBe(0);
    expect(await main(['seed'], env)).toBe(0);
    expect(storage.sandboxes.list()).toHaveLength(1);
    expect(payments(storage)).toHaveLength(12);
  });

  test('refuses to seed the same data twice', async () => {
    const { env, err } = testEnv();
    expect(await main(['seed'], env)).toBe(0);
    expect(await main(['seed'], env)).toBe(1);
    expect(err[0]).toContain('already holds the payments of --seed 1');
  });

  test('fails when the requested sandbox does not exist', async () => {
    const { env, err } = testEnv();
    expect(await main(['seed', '--sandbox', 'nope'], env)).toBe(1);
    expect(err[0]).toBe('sandbox not found: nope');
  });

  test('rejects a non numeric count', async () => {
    const { env, err } = testEnv();
    expect(await main(['seed', '--payments', 'abc'], env)).toBe(2);
    expect(err[0]).toContain('--payments must be an integer');
  });

  test('rejects a count outside the allowed range', async () => {
    const { env } = testEnv();
    expect(await main(['seed', '--payments', '0'], env)).toBe(2);
    expect(await main(['seed', '--payments', '501'], env)).toBe(2);
  });

  test('rejects a negative seed', async () => {
    const { env, err } = testEnv();
    expect(await main(['seed', '--seed', '-1'], env)).toBe(2);
    expect(err[0]).toContain('--seed');
  });
});
