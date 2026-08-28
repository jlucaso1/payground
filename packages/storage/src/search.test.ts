import { afterEach, describe, expect, test } from 'bun:test';
import { type Payment, type SandboxStore, paymentId, sandboxId, unwrap } from '@payground/core';
import { create } from '@payground/core';
import { CARD, PIX, amount, input } from '@payground/core/payment/fixture.ts';
import type { Storage } from './index.ts';
import { storageWith } from './fixture.ts';

let storage: Storage;
afterEach(() => storage.close());

function seed(): SandboxStore {
  const made = storageWith('a');
  storage = made.storage;
  const store = storage.forSandbox(sandboxId('a'));

  const rows: [string, Parameters<typeof input>[0], Parameters<typeof create>[1], number][] = [
    ['p1', { method: PIX, externalReference: 'ORDER-1' }, { kind: 'pending', reason: 'awaiting_payer' }, 1_000],
    ['p2', { method: CARD, externalReference: 'ORDER-2' }, { kind: 'settle' }, 2_000],
    ['p3', { method: CARD, externalReference: 'ORDER-2' }, { kind: 'decline', reason: 'high_risk' }, 3_000],
    ['p4', { method: PIX, expiresAt: 5_000 }, { kind: 'pending', reason: 'awaiting_payer' }, 4_000],
  ];

  rows.forEach(([id, overrides, decision, at], i) => {
    const p = unwrap(create(input({ ...overrides, id: paymentId(id), sandbox: sandboxId('a') }), decision, at));
    store.payments.insert(p, i + 1);
  });
  return store;
}

const ids = (page: { results: readonly Payment[] }): string[] => page.results.map((p) => String(p.id));

describe('search', () => {
  test('returns everything newest first by default', () => {
    expect(ids(seed().payments.search({}))).toEqual(['p4', 'p3', 'p2', 'p1']);
  });

  test('sorts ascending on request', () => {
    expect(ids(seed().payments.search({ order: 'asc' }))).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  test('filters by state', () => {
    expect(ids(seed().payments.search({ states: ['pending'] }))).toEqual(['p4', 'p1']);
    expect(ids(seed().payments.search({ states: ['succeeded', 'failed'] }))).toEqual(['p3', 'p2']);
    expect(ids(seed().payments.search({ states: [] }))).toHaveLength(4);
  });

  test('filters by method, external reference and payer', () => {
    expect(ids(seed().payments.search({ methodCode: 'pix' }))).toEqual(['p4', 'p1']);
    expect(ids(seed().payments.search({ externalReference: 'ORDER-2' }))).toEqual(['p3', 'p2']);
    expect(seed().payments.search({ payerEmail: 'payer@example.com' }).total).toBe(4);
    expect(seed().payments.search({ payerEmail: 'nobody@example.com' }).total).toBe(0);
  });

  test('filters by creation window inclusively', () => {
    expect(ids(seed().payments.search({ createdFrom: 2_000, createdTo: 3_000 }))).toEqual(['p3', 'p2']);
  });

  test('finds pending payments whose deadline has passed', () => {
    const store = seed();
    expect(ids(store.payments.search({ expiredBy: 4_999 }))).toEqual([]);
    expect(ids(store.payments.search({ expiredBy: 5_000 }))).toEqual(['p4']);
  });

  test('pages without losing the total', () => {
    const store = seed();
    const page = store.payments.search({ limit: 2, offset: 1, order: 'asc' });
    expect(page).toMatchObject({ total: 4, limit: 2, offset: 1 });
    expect(ids(page)).toEqual(['p2', 'p3']);
    expect(ids(store.payments.search({ limit: 2, offset: 10 }))).toEqual([]);
  });

  test('clamps hostile paging values', () => {
    const store = seed();
    expect(store.payments.search({ limit: 0 }).limit).toBe(1);
    expect(store.payments.search({ limit: 10_000 }).limit).toBe(1_000);
    expect(store.payments.search({ offset: -5 }).offset).toBe(0);
  });

  test('a filter value that looks like SQL is treated as data', () => {
    const store = seed();
    expect(store.payments.search({ externalReference: "' or 1=1 --" }).total).toBe(0);
    expect(store.payments.search({ methodCode: 'pix; drop table payments' }).total).toBe(0);
    expect(store.payments.search({}).total).toBe(4);
  });

  test('combines filters', () => {
    expect(ids(seed().payments.search({ states: ['failed'], methodCode: 'card' }))).toEqual([]);
    expect(ids(seed().payments.search({ states: ['failed'], externalReference: 'ORDER-2' }))).toEqual(['p3']);
  });

  test('ignores an amount that is not a filter', () => {
    expect(seed().payments.search({}).results.every((p) => p.amount === amount(10_000))).toBe(true);
  });
});
