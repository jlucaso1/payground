import { expect, test } from 'bun:test';
import { apply, fromDecimal, unwrap } from '@payground/core';
import { SeededRandom } from '@payground/core/testing.ts';
import { harness } from './fixture.ts';
import { createPayment, createRefund } from './payments.ts';
import {
  createSettlementReport,
  createSettlementReportConfig,
  downloadSettlementReport,
  getSettlementReportTask,
} from './reports-settlement.ts';

const SEED = 20_240_612;
const WINDOW = { begin_date: '2000-01-01T00:00:00Z', end_date: '2100-01-01T00:00:00Z' };
const GENERATION_MS = 6_000;
const SEPARATOR = ';';

/** Values chosen to collide with the delimiter, the quote and the row terminator. */
const REFERENCES = ['plain', 'a;b', 'say "hi"', 'line\nbreak', 'crlf\r\nhere', '', 'mixed;"\n'];

const pick = <T>(random: SeededRandom, values: readonly T[]): T => {
  const value = values[random.int(values.length)];
  if (value === undefined) throw new Error('empty pool');
  return value;
};

/** RFC 4180 reader, so the fuzzer proves the writer round-trips its own escaping. */
function parseCsv(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === '') quoted = true;
    else if (char === separator) {
      row.push(field);
      field = '';
    } else if (char === '\r' && text[index + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
    } else field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const cents = (value: string): number => {
  const negative = value.startsWith('-');
  return (negative ? -1 : 1) * unwrap(fromDecimal(Number(negative ? value.slice(1) : value)));
};

test('report totals reconcile exactly with the payments and refunds behind them', () => {
  const random = new SeededRandom(SEED);
  const seen = { SETTLEMENT: 0, REFUND: 0, CHARGEBACK: 0 };

  for (let round = 0; round < 40; round++) {
    const app = harness(1_700_000_000_000 + round * 86_400_000);
    createSettlementReportConfig(app.context, { column_separator: SEPARATOR });

    for (let index = 0; index < 1 + random.int(8); index++) {
      const amount = (100 + random.int(500_000)) / 100;
      const settles = random.int(4) > 0;
      const created = unwrap(
        createPayment(app.context, {
          transaction_amount: amount,
          payment_method_id: settles ? 'account_money' : 'pix',
          payer: { email: `payer${index}@example.com` },
          external_reference: pick(random, REFERENCES),
        }),
      ).body as { id: number };
      if (!settles) continue;

      app.clock.advance(1_000);
      const refunds = random.int(3);
      for (let attempt = 0; attempt < refunds; attempt++) {
        createRefund(app.context, String(created.id), { amount: Math.max(0.01, Math.round(amount * 25) / 100) });
        app.clock.advance(1_000);
      }

      const stored = app.context.store.payments
        .search({ limit: 1000 })
        .results.find((payment) => app.context.store.payments.sequenceOf(payment.id) === created.id);
      if (random.int(5) === 0 && stored !== undefined && stored.status.state === 'succeeded') {
        const disputed = unwrap(apply(stored, { type: 'dispute' }, app.clock.now()));
        app.context.store.payments.update(disputed.payment);
        app.clock.advance(1_000);
        const back = unwrap(apply(disputed.payment, { type: 'resolve', outcome: 'chargeback' }, app.clock.now()));
        app.context.store.payments.update(back.payment);
        app.clock.advance(1_000);
      }
    }

    // What the store holds, independent of the report.
    let expectedSettlements = 0;
    let expectedRefunds = 0;
    let expectedChargebacks = 0;
    let expectedRows = 0;
    for (const payment of app.context.store.payments.search({ limit: 1000 }).results) {
      if (payment.settledAt === null) continue;
      if (payment.capturedAmount > 0) {
        expectedSettlements += payment.capturedAmount;
        expectedRows += 1;
      }
      for (const refund of app.context.store.refunds.listFor(payment.id)) {
        if (refund.status !== 'approved') continue;
        expectedRefunds += refund.amount;
        expectedRows += 1;
      }
      const reversed = payment.capturedAmount - payment.refundedAmount;
      if (payment.status.state === 'charged_back' && reversed > 0) {
        expectedChargebacks += reversed;
        expectedRows += 1;
      }
    }

    const task = unwrap(createSettlementReport(app.context, WINDOW)).body as { id: string };
    app.clock.advance(GENERATION_MS);
    const done = unwrap(getSettlementReportTask(app.context, task.id)).body as { file_name: string };
    const file = unwrap(downloadSettlementReport(app.context, done.file_name));

    const rows = parseCsv(file.content, SEPARATOR);
    const header = rows[0] ?? [];
    const body = rows.slice(1);
    expect(body).toHaveLength(expectedRows);

    const at = (row: string[], key: string): string => row[header.indexOf(key)] ?? '';
    const totals = { SETTLEMENT: 0, REFUND: 0, CHARGEBACK: 0 };

    for (const row of body) {
      expect(row).toHaveLength(header.length);
      const amount = cents(at(row, 'TRANSACTION_AMOUNT'));
      const type = at(row, 'TRANSACTION_TYPE') as keyof typeof totals;
      expect(Object.keys(totals)).toContain(type);
      expect(type === 'SETTLEMENT' ? amount > 0 : amount < 0).toBe(true);
      // No fee model, so every row nets out to its gross; the three fee columns stay zero.
      expect(cents(at(row, 'SETTLEMENT_NET_AMOUNT'))).toBe(amount);
      expect(cents(at(row, 'MP_FEE_AMOUNT'))).toBe(0);
      expect(cents(at(row, 'FINANCING_FEE_AMOUNT'))).toBe(0);
      expect(cents(at(row, 'TAXES_AMOUNT'))).toBe(0);
      totals[type] += Math.abs(amount);
      seen[type] += 1;
    }

    expect([totals.SETTLEMENT, totals.REFUND, totals.CHARGEBACK]).toEqual([
      expectedSettlements,
      expectedRefunds,
      expectedChargebacks,
    ]);
  }

  // Guards against a sweep that silently stopped producing one of the movement kinds.
  expect(seen.SETTLEMENT > 0 && seen.REFUND > 0 && seen.CHARGEBACK > 0).toBe(true);
});
