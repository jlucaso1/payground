import { describe, expect, test } from 'bun:test';
import { DOCUMENT_KINDS } from '../src/api/client-documents.ts';
import {
  documentAmounts,
  firstPopulatedKind,
  groupKinds,
  kindLabel,
} from '../src/lib/documents.ts';

describe('kindLabel', () => {
  test('turns snake case into words', () => {
    expect(kindLabel('preapproval_plan')).toBe('preapproval plan');
    expect(kindLabel('order')).toBe('order');
    expect(kindLabel('')).toBe('');
  });
});

describe('groupKinds', () => {
  test('lists every supported kind even with no counts', () => {
    const entries = groupKinds([]);
    expect(entries.length).toBe(DOCUMENT_KINDS.length);
    expect(entries.every((entry) => entry.count === 0 && entry.known)).toBe(true);
    expect(entries[0]?.kind).toBe('card_token');
  });

  test('applies counts and keeps the canonical order', () => {
    const entries = groupKinds([
      { kind: 'preapproval', count: 3 },
      { kind: 'preference', count: 7 },
    ]);
    const byKind = new Map(entries.map((entry) => [entry.kind, entry.count]));
    expect(byKind.get('preference')).toBe(7);
    expect(byKind.get('preapproval')).toBe(3);
    expect(byKind.get('order')).toBe(0);
    expect(entries.map((entry) => entry.kind).indexOf('preference')).toBe(
      DOCUMENT_KINDS.indexOf('preference'),
    );
  });

  test('sums duplicate entries', () => {
    const entries = groupKinds([
      { kind: 'order', count: 2 },
      { kind: 'order', count: 5 },
    ]);
    expect(entries.find((entry) => entry.kind === 'order')?.count).toBe(7);
  });

  test('appends unknown kinds after the known ones, sorted', () => {
    const entries = groupKinds([
      { kind: 'zeta_thing', count: 1 },
      { kind: 'alpha_thing', count: 2 },
    ]);
    const tail = entries.slice(DOCUMENT_KINDS.length);
    expect(tail.map((entry) => entry.kind)).toEqual(['alpha_thing', 'zeta_thing']);
    expect(tail.every((entry) => !entry.known)).toBe(true);
  });

  test('ignores blank kinds and clamps hostile counts', () => {
    const entries = groupKinds([
      { kind: '', count: 9 },
      { kind: 'order', count: -4 },
      { kind: 'claim', count: Number.NaN },
      { kind: 'store', count: 2.7 },
    ]);
    expect(entries.some((entry) => entry.kind === '')).toBe(false);
    expect(entries.find((entry) => entry.kind === 'order')?.count).toBe(0);
    expect(entries.find((entry) => entry.kind === 'claim')?.count).toBe(0);
    expect(entries.find((entry) => entry.kind === 'store')?.count).toBe(2);
  });
});

describe('firstPopulatedKind', () => {
  test('returns null when nothing has documents', () => {
    expect(firstPopulatedKind(groupKinds([]))).toBe(null);
  });

  test('returns the first kind with documents in canonical order', () => {
    expect(
      firstPopulatedKind(
        groupKinds([
          { kind: 'preapproval', count: 1 },
          { kind: 'preference', count: 1 },
        ]),
      ),
    ).toBe('preference');
  });
});

describe('documentAmounts', () => {
  test('formats a top level amount using the document currency', () => {
    expect(documentAmounts({ transaction_amount: 100.5, currency_id: 'BRL' })).toEqual([
      { path: 'transaction_amount', text: 'BRL 100.50' },
    ]);
  });

  test('reads amounts nested one level deep and inherits the root currency', () => {
    expect(
      documentAmounts({ currency_id: 'ARS', auto_recurring: { transaction_amount: 29.9 } }),
    ).toEqual([{ path: 'auto_recurring.transaction_amount', text: 'ARS 29.90' }]);
  });

  test('a nested currency overrides the root one', () => {
    expect(
      documentAmounts({ currency_id: 'BRL', leg: { currency: 'CLP', total_amount: 1500 } }),
    ).toEqual([{ path: 'leg.total_amount', text: 'CLP 1,500' }]);
  });

  test('skips amounts with no currency in scope', () => {
    expect(documentAmounts({ transaction_amount: 10 })).toEqual([]);
  });

  test('skips values that are not finite decimals', () => {
    expect(
      documentAmounts({ currency_id: 'BRL', a_amount: 1e-7, b_amount: 1.005, c_amount: '5' }),
    ).toEqual([]);
  });

  test('handles negative amounts and zero', () => {
    expect(documentAmounts({ currency_id: 'BRL', refunded_amount: -12.3, net_amount: 0 })).toEqual([
      { path: 'refunded_amount', text: '-BRL 12.30' },
      { path: 'net_amount', text: 'BRL 0.00' },
    ]);
  });

  test('ignores arrays and non-amount keys', () => {
    expect(
      documentAmounts({ currency_id: 'BRL', items: [{ unit_amount: 5 }], quantity: 3 }),
    ).toEqual([]);
  });

  test('is empty for an empty document', () => {
    expect(documentAmounts({})).toEqual([]);
  });

  test('tolerates a malformed document instead of throwing', () => {
    expect(documentAmounts(null)).toEqual([]);
    expect(documentAmounts(undefined)).toEqual([]);
    expect(documentAmounts([1, 2])).toEqual([]);
    expect(documentAmounts('nope')).toEqual([]);
    expect(documentAmounts({ currency_id: 'BRL', nested: null, total_amount: 1 })).toEqual([
      { path: 'total_amount', text: 'BRL 1.00' },
    ]);
  });
});
