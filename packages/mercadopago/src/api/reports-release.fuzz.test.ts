import { expect, test } from 'bun:test';
import { SeededRandom } from '@payground/core/testing.ts';
import { testContext } from '../testing.ts';
import { type Config, type ReleaseColumn, buildRows, renderCsv } from './reports-release.ts';
import { type SeededPayment, seedLedger } from './reports-release.testing.ts';

const NOW = Date.UTC(2024, 2, 10, 15, 0, 0);
const DAY = 86_400_000;
const KINDS = ['card', 'bank_transfer', 'voucher', 'wallet'] as const;

const NUMERIC: readonly ReleaseColumn[] = [
  'NET_CREDIT_AMOUNT',
  'NET_DEBIT_AMOUNT',
  'GROSS_AMOUNT',
  'MP_FEE_AMOUNT',
  'FINANCING_FEE_AMOUNT',
  'SHIPPING_FEE_AMOUNT',
  'TAXES_AMOUNT',
  'COUPON_AMOUNT',
];

/** Only numeric columns, so summing the file needs no CSV parser. */
const CONFIG: Config = {
  columns: NUMERIC.map((key) => ({ key, alias: key })),
  filePrefix: 'fuzz',
  frequency: { hour: 0, type: 'daily' },
  sftp: null,
  separator: ',',
  timezone: 'UTC',
  emails: [],
  scheduled: false,
};

function ledger(random: SeededRandom): SeededPayment[] {
  const entries: SeededPayment[] = [];
  for (let index = 0, count = 1 + random.int(25); index < count; index++) {
    const amount = 100 + random.int(500_000);
    const settled = random.int(4) !== 0;
    const settledAt = settled ? NOW - random.int(20) * DAY : null;
    const refunds: { amount: number; at: number; approved?: boolean }[] = [];
    if (settled && random.int(2) === 0) {
      const part = 1 + random.int(amount);
      refunds.push({ amount: part, at: (settledAt ?? NOW) + random.int(3) * DAY, approved: random.int(5) !== 0 });
    }
    entries.push({
      amount,
      settledAt,
      installments: 1 + random.int(12),
      kind: KINDS[random.int(KINDS.length)] ?? 'card',
      description: `d${index},"x"\n`,
      externalReference: random.int(2) === 0 ? null : `ext-${index}`,
      refunds,
    });
  }
  return entries;
}

test('report totals reconcile with the payments and refunds behind them', () => {
  const random = new SeededRandom(20_240_310);

  for (let round = 0; round < 40; round++) {
    const harness = testContext(NOW);
    const entries = ledger(random);
    seedLedger(harness.context, entries);

    const beginAt = NOW - 10 * DAY;
    const endAt = NOW + 10 * DAY;
    const within = (at: number): boolean => at >= beginAt && at <= endAt;
    const rows = buildRows(harness.context, beginAt, endAt);
    for (const row of rows) expect(within(row.releaseAt)).toBe(true);

    const lines = renderCsv(rows, CONFIG).trimEnd().split('\n');
    expect(lines[0]).toBe(NUMERIC.join(','));

    const totals = new Map<ReleaseColumn, number>(NUMERIC.map((column) => [column, 0]));
    for (const line of lines.slice(1)) {
      const cells = line.split(',');
      expect(cells.length).toBe(NUMERIC.length);
      NUMERIC.forEach((column, index) => {
        totals.set(column, (totals.get(column) ?? 0) + Math.round(Number(cells[index]) * 100));
      });
    }

    const releases = entries.filter((entry) => entry.settledAt !== null && within(entry.settledAt));
    const refunds = entries.flatMap((entry) =>
      (entry.refunds ?? []).filter((refund) => refund.approved !== false && within(refund.at)),
    );
    const total = (column: ReleaseColumn): number => totals.get(column) ?? 0;
    const fees =
      total('MP_FEE_AMOUNT') +
      total('FINANCING_FEE_AMOUNT') +
      total('SHIPPING_FEE_AMOUNT') +
      total('TAXES_AMOUNT') +
      total('COUPON_AMOUNT');

    expect(lines.length - 1).toBe(releases.length + refunds.length);
    // The gross column is signed, so it sums to the money that actually moved.
    expect(total('GROSS_AMOUNT')).toBe(
      releases.reduce((sum, entry) => sum + entry.amount, 0) -
        refunds.reduce((sum, refund) => sum + refund.amount, 0),
    );
    expect(total('NET_CREDIT_AMOUNT') - total('NET_DEBIT_AMOUNT')).toBe(total('GROSS_AMOUNT') - fees);
  }
});
