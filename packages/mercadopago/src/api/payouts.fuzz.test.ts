import { expect, test } from 'bun:test';
import type { JsonObject } from '@payground/core';
import { SeededRandom } from '@payground/core/testing.ts';
import { harness } from './fixture.ts';
import { cancelPayoutTransaction, createPayout, deriveStatus, type PayoutState } from './payouts.ts';

const RECEIVERS: readonly JsonObject[] = [
  { pix_key: 'seller@shop.com' },
  { pix_key: '+5511999998888' },
  { pix_key: '12345678909' },
  { pix_key: '00000000-0000-4000-8000-000000000001' },
  { pix_key: 'not a pix key' },
  { bank_code: '237', branch: '0001', account: '12345-6', document: '12345678909' },
  { bank_code: '23', branch: '0001', account: '12345-6', document: '12345678909' },
];

const pick = <T>(random: SeededRandom, values: readonly T[]): T => {
  const value = values[random.int(values.length)];
  if (value === undefined) throw new Error('empty pool');
  return value;
};

const stateOf = (transaction: JsonObject): PayoutState => ({
  status: transaction['status'] as PayoutState['status'],
  detail: transaction['status_detail'] as string,
});

test('a payout status always agrees with its transactions', () => {
  const random = new SeededRandom(20_240_902);
  const app = harness();
  const seen = new Set<string>();

  for (let round = 0; round < 300; round++) {
    const count = 1 + random.int(4);
    const entries = Array.from({ length: count }, () => ({
      amount: (1 + random.int(5_000)) / 100,
      receiver: pick(random, RECEIVERS),
    }));
    const total = entries.reduce((sum, entry) => sum + Math.round(entry.amount * 100), 0) / 100;

    const created = createPayout(app.context, {
      external_reference: `P${round}`,
      currency_id: 'BRL',
      total_amount: total,
      transactions: entries,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));

    let body = created.value.body as JsonObject;
    const id = body['id'] as string;

    // Cancelling pending transfers must move the batch exactly as the fold says.
    const cancelling = (body['transactions'] as JsonObject[]).filter(
      (entry) => entry['status'] === 'pending' && random.int(5) < 3,
    );
    for (const entry of cancelling) {
      expect(cancelPayoutTransaction(app.context, id, entry['id'] as string).ok).toBe(true);
    }
    if (cancelling.length > 0) body = app.context.store.documents.get('payout', id)?.doc as JsonObject;

    const transactions = (body['transactions'] as JsonObject[]).map(stateOf);
    const derived = deriveStatus(transactions);
    expect([body['status'], body['status_detail']]).toEqual([derived.status, derived.detail]);
    expect(app.context.store.documents.get('payout', id)?.status).toBe(derived.status);

    const settled = transactions.filter((state) => state.status === 'processed').length;
    const pending = transactions.filter((state) => state.status === 'pending').length;
    if (pending > 0) expect(derived.status).toBe('pending');
    else if (settled === transactions.length) expect(derived.status).toBe('processed');
    else if (settled > 0) expect(derived.status).toBe('partially_processed');
    else expect(['failed', 'cancelled']).toContain(derived.status);

    const sum = (body['transactions'] as JsonObject[]).reduce(
      (acc, entry) => acc + Math.round((entry['amount'] as number) * 100),
      0,
    );
    expect(sum).toBe(Math.round((body['total_amount'] as number) * 100));

    seen.add(derived.status);
  }

  expect([...seen].sort()).toEqual(['cancelled', 'failed', 'partially_processed', 'pending', 'processed']);
});
