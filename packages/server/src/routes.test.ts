import { describe, expect, test } from 'bun:test';
import { ManualClock, SeededIdGenerator } from '@payground/core/testing.ts';
import { ROUTES } from '@payground/mercadopago';
import { Storage } from '@payground/storage';
import { createApp } from './app.ts';
import { MODULES } from './routes/index.ts';

const SPEC_OPERATIONS = new Set(ROUTES.map((route) => route.operationId));

const app = () =>
  createApp({
    storage: Storage.open(),
    clock: new ManualClock(1_700_000_000_000),
    ids: new SeededIdGenerator(),
    deliveryIntervalMs: 0,
  });

describe('module registry', () => {
  test('module names are unique', () => {
    const names = MODULES.map((module) => module.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('every spec operation is claimed exactly once', () => {
    const claims = new Map<string, string[]>();
    for (const module of MODULES) {
      for (const id of [...module.operations, ...module.pending.map((p) => p.operationId)]) {
        claims.set(id, [...(claims.get(id) ?? []), module.name]);
      }
    }

    const duplicated = [...claims].filter(([, owners]) => owners.length > 1);
    expect(duplicated).toEqual([]);

    const unclaimed = [...SPEC_OPERATIONS].filter((id) => !claims.has(id)).sort();
    expect(unclaimed).toEqual([]);

    const unknown = [...claims.keys()].filter((id) => !SPEC_OPERATIONS.has(id)).sort();
    expect(unknown).toEqual([]);
  });

  test('pending operations always explain themselves', () => {
    for (const module of MODULES) {
      for (const entry of module.pending) {
        expect([module.name, entry.operationId, entry.reason.length > 5]).toEqual([
          module.name,
          entry.operationId,
          true,
        ]);
      }
    }
  });

  test('reports how much of the API is emulated', () => {
    const implemented = MODULES.flatMap((module) => module.operations).length;
    const pending = MODULES.flatMap((module) => module.pending).length;
    expect(implemented + pending).toBe(SPEC_OPERATIONS.size);
    expect(implemented).toBeGreaterThan(0);
  });
});

describe('registered routes', () => {
  const registered = new Set(Object.keys(app().routes));

  test('every registered pattern is a valid Bun path', () => {
    for (const pattern of registered) {
      expect(pattern.startsWith('/')).toBe(true);
      expect(pattern).not.toContain('{');
    }
  });

  test('a module that claims an operation registers a route for its path', () => {
    /** Our patterns use short parameter names; the spec spells them out. */
    const normalise = (pattern: string): string =>
      pattern
        .replace(/:order_id|:customer_id|:claim_id|:payout_id|:user_id/g, ':id')
        .replace(/:transaction_id|:refund_id|:address_id|:action_id/g, ':tid');

    const claimed = new Set(MODULES.flatMap((module) => module.operations));
    const missing = ROUTES.filter((route) => claimed.has(route.operationId))
      .map((route) => route.pattern)
      .filter((pattern) => !registered.has(normalise(pattern)) && !registered.has(pattern));

    expect([...new Set(missing)]).toEqual([]);
  });

  test('the control namespace never overlaps the emulated one', () => {
    for (const pattern of registered) {
      const control = pattern.startsWith('/_payground');
      const emulated = ROUTES.some((route) => route.pattern === pattern);
      expect(control && emulated).toBe(false);
    }
  });
});
