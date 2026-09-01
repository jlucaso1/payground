import { describe, expect, test } from 'bun:test';
import { type Payment, type Result, apply, unwrap } from '@payground/core';
import type { ErrorBody } from '../errors.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { type Harness, harness } from './fixture.ts';
import { createPayment, createRefund } from './payments.ts';
import {
  DEFAULT_CONFIG,
  type Row,
  createSettlementReport,
  createSettlementReportConfig,
  disableSettlementReportSchedule,
  downloadSettlementReport,
  enableSettlementReportSchedule,
  getSettlementReport,
  getSettlementReportConfig,
  getSettlementReportTask,
  listScheduledSettlementReports,
  renderCsv,
  runSettlementReports,
  searchSettlementReports,
  updateSettlementReportConfig,
} from './reports-settlement.ts';

const WINDOW = { begin_date: '2020-01-01T00:00:00Z', end_date: '2030-01-01T00:00:00Z' };
const GENERATION_MS = 6_000;

const body = (result: Result<Rendered, ErrorBody>): any => unwrap(result).body;
const failure = (result: Result<unknown, ErrorBody>): ErrorBody => {
  if (result.ok) throw new Error('expected a failure');
  return result.error;
};

const pay = (context: ServiceContext, overrides: Record<string, unknown> = {}): any =>
  body(
    createPayment(context, {
      transaction_amount: 100.5,
      payment_method_id: 'account_money',
      payer: { email: 'payer@example.com' },
      ...overrides,
    }),
  );

const pix = (context: ServiceContext): any =>
  body(
    createPayment(context, {
      transaction_amount: 42,
      payment_method_id: 'pix',
      payer: { email: 'payer@example.com' },
    }),
  );

/** Runs a report to completion and returns its CSV lines, header excluded. */
function generate(app: Harness, window = WINDOW): { header: string; rows: string[]; fileName: string } {
  const task = body(createSettlementReport(app.context, window));
  app.clock.advance(GENERATION_MS);
  const done = body(getSettlementReportTask(app.context, task.id));
  expect(done.status).toBe('done');
  const file = unwrap(downloadSettlementReport(app.context, done.file_name));
  const lines = file.content.split('\r\n').filter((line) => line !== '');
  const [header = '', ...rows] = lines;
  return { header, rows, fileName: file.fileName };
}

const column = (line: string, index: number, separator = ','): string => line.split(separator)[index] ?? '';

describe('config', () => {
  test('reports the defaults before anything is configured', () => {
    const app = harness();
    expect(body(getSettlementReportConfig(app.context))).toMatchObject({
      file_name_prefix: 'settlement-report',
      column_separator: ',',
      display_timezone: 'UTC',
      scheduled: false,
    });
  });

  test('creates and then merges partial updates', () => {
    const app = harness();
    createSettlementReportConfig(app.context, {
      file_name_prefix: 'my_report',
      column_separator: ';',
      display_timezone: 'America/Sao_Paulo',
    });
    const merged = body(updateSettlementReportConfig(app.context, { column_separator: ',' }));
    expect(merged).toMatchObject({
      file_name_prefix: 'my_report',
      column_separator: ',',
      display_timezone: 'America/Sao_Paulo',
    });
  });

  test('a create resets the rendering options but leaves the schedule alone', () => {
    const app = harness();
    enableSettlementReportSchedule(app.context, { frequency: { type: 'weekly', hour: 6 } });
    createSettlementReportConfig(app.context, { file_name_prefix: 'fresh' });
    expect(body(getSettlementReportConfig(app.context))).toMatchObject({
      file_name_prefix: 'fresh',
      scheduled: true,
      frequency: { type: 'weekly', hour: 6 },
    });
  });

  test('rejects an unusable prefix, separator, zone or column', () => {
    const app = harness();
    expect(failure(createSettlementReportConfig(app.context, { file_name_prefix: '../etc/passwd' })).status).toBe(400);
    expect(failure(createSettlementReportConfig(app.context, { column_separator: '|' })).status).toBe(400);
    expect(failure(createSettlementReportConfig(app.context, { display_timezone: 'Mars/Olympus' })).status).toBe(400);
    expect(failure(createSettlementReportConfig(app.context, { columns: [{ key: 'NOPE' }] })).status).toBe(400);
    expect(failure(createSettlementReportConfig(app.context, { columns: [] })).status).toBe(400);
    // A rejected config is never stored.
    expect(body(getSettlementReportConfig(app.context)).file_name_prefix).toBe('settlement-report');
  });
});

describe('schedule', () => {
  test('enables, lists and disables', () => {
    const app = harness();
    expect(body(listScheduledSettlementReports(app.context)).results).toEqual([]);

    const enabled = body(enableSettlementReportSchedule(app.context, { frequency: { type: 'weekly', hour: 6 } }));
    expect(enabled).toMatchObject({ scheduled: true, frequency: { type: 'weekly', hour: 6 } });

    const listed = body(listScheduledSettlementReports(app.context)).results;
    expect(listed).toHaveLength(1);
    // 2023-11-14T22:13:20Z is a Tuesday, so the next weekly run is Monday the 20th at 06:00.
    expect(listed[0].next_execution).toBe('2023-11-20T06:00:00+00:00');

    // The hour is an hour of the day in display_timezone, not in UTC.
    updateSettlementReportConfig(app.context, { display_timezone: 'America/Sao_Paulo' });
    expect(body(listScheduledSettlementReports(app.context)).results[0].next_execution).toBe(
      '2023-11-20T06:00:00-03:00',
    );

    expect(body(disableSettlementReportSchedule(app.context))).toMatchObject({ scheduled: false });
    expect(body(listScheduledSettlementReports(app.context)).results).toEqual([]);
  });

  test('defaults to daily and rejects an impossible hour', () => {
    const app = harness();
    expect(body(enableSettlementReportSchedule(app.context, {})).frequency).toEqual({ type: 'daily', hour: 0 });
    expect(failure(enableSettlementReportSchedule(app.context, { frequency: { hour: 24 } })).status).toBe(400);
  });
});

describe('generation', () => {
  test('moves through the task states as the clock advances', () => {
    const app = harness();
    const task = body(createSettlementReport(app.context, WINDOW));
    expect(task).toMatchObject({ status: 'pending', file_name: null, download_url: null });

    app.clock.advance(1_000);
    expect(body(getSettlementReportTask(app.context, task.id)).status).toBe('in_progress');
    expect(body(getSettlementReport(app.context, new URLSearchParams())).results).toEqual([]);

    app.clock.advance(5_000);
    const done = body(getSettlementReportTask(app.context, task.id));
    expect(done.status).toBe('done');
    expect(done.download_url).toContain(done.file_name);
    expect(body(getSettlementReport(app.context, new URLSearchParams())).results).toHaveLength(1);
  });

  test('the file only exists once the task is done', () => {
    const app = harness();
    const task = body(createSettlementReport(app.context, WINDOW));
    const name = `settlement-report-2020-01-01-2030-01-01-${task.id.slice(-32)}.csv`;
    expect(failure(downloadSettlementReport(app.context, name)).status).toBe(404);
    expect(failure(downloadSettlementReport(app.context, 'nothing.csv')).status).toBe(404);
  });

  test('runSettlementReports settles the whole queue at once', () => {
    const app = harness();
    createSettlementReport(app.context, WINDOW);
    createSettlementReport(app.context, WINDOW);
    expect(runSettlementReports(app.context)).toEqual({ generated: 0 });
    app.clock.advance(GENERATION_MS);
    expect(runSettlementReports(app.context)).toEqual({ generated: 2 });
    expect(runSettlementReports(app.context)).toEqual({ generated: 0 });
  });

  test('rejects a malformed or inverted window', () => {
    const app = harness();
    expect(failure(createSettlementReport(app.context, {})).status).toBe(400);
    expect(failure(createSettlementReport(app.context, { begin_date: 'yesterday', end_date: 'now' })).status).toBe(400);
    expect(
      failure(createSettlementReport(app.context, { begin_date: WINDOW.end_date, end_date: WINDOW.begin_date })).status,
    ).toBe(400);
  });

  test('the file is a snapshot: later payments do not change it', () => {
    const app = harness();
    pay(app.context);
    const first = generate(app);
    expect(first.rows).toHaveLength(1);

    pay(app.context);
    const again = unwrap(downloadSettlementReport(app.context, first.fileName));
    expect(again.content.split('\r\n').filter((line) => line !== '')).toHaveLength(2);
    expect(generate(app).rows).toHaveLength(2);
  });
});

describe('rows', () => {
  test('carries the sandbox payments and refunds, and nothing else', () => {
    const app = harness();
    const settled = pay(app.context, { external_reference: 'order-1' });
    pix(app.context); // still pending: no money moved
    app.clock.advance(1_000);
    createRefund(app.context, String(settled.id), { amount: 10.25 });

    const { rows } = generate(app);
    expect(rows).toHaveLength(2);
    expect(column(rows[0] ?? '', 3)).toBe('SETTLEMENT');
    expect(column(rows[0] ?? '', 4)).toBe('100.50');
    expect(column(rows[0] ?? '', 1)).toBe(String(settled.id));
    expect(column(rows[0] ?? '', 2)).toBe('order-1');
    expect(column(rows[1] ?? '', 3)).toBe('REFUND');
    expect(column(rows[1] ?? '', 4)).toBe('-10.25');
    // No fee model, so the net equals the gross; see FIDELITY.md.
    expect(column(rows[0] ?? '', 6)).toBe('100.50');
    expect(column(rows[0] ?? '', 7)).toBe('0.00');
  });

  test('a chargeback reverses what is left of the payment', () => {
    const app = harness();
    const created = pay(app.context);
    app.clock.advance(1_000);
    createRefund(app.context, String(created.id), { amount: 0.5 });

    const stored = app.context.store.payments.search({ limit: 1 }).results[0] as Payment;
    const disputed = unwrap(apply(stored, { type: 'dispute' }, app.clock.now()));
    app.context.store.payments.update(disputed.payment);
    app.clock.advance(1_000);
    const back = unwrap(apply(disputed.payment, { type: 'resolve', outcome: 'chargeback' }, app.clock.now()));
    app.context.store.payments.update(back.payment);

    const { rows } = generate(app);
    expect(rows.map((row) => column(row, 3))).toEqual(['SETTLEMENT', 'REFUND', 'CHARGEBACK']);
    expect(column(rows[2] ?? '', 4)).toBe('-100.00');
    expect(column(rows[2] ?? '', 14)).toBe('charged_back');
  });

  test('the window is honoured', () => {
    const app = harness();
    pay(app.context);
    expect(generate(app, { begin_date: '2020-01-01T00:00:00Z', end_date: '2020-01-02T00:00:00Z' }).rows).toEqual([]);
    expect(generate(app).rows).toHaveLength(1);
  });

  test('the window is half-open, so back-to-back reports never double count', () => {
    const app = harness();
    pay(app.context);
    const at = new Date(app.clock.now()).toISOString();
    expect(generate(app, { begin_date: '2020-01-01T00:00:00Z', end_date: at }).rows).toEqual([]);
    expect(generate(app, { begin_date: at, end_date: '2030-01-01T00:00:00Z' }).rows).toHaveLength(1);
  });

  test('search filters the generated files by window', () => {
    const app = harness();
    generate(app);
    generate(app, { begin_date: '2021-01-01T00:00:00Z', end_date: '2021-02-01T00:00:00Z' });
    const narrow = new URLSearchParams({ begin_date: '2021-01-01T00:00:00Z', end_date: '2021-02-01T00:00:00Z' });
    expect(body(searchSettlementReports(app.context, narrow)).results).toHaveLength(1);
    expect(body(searchSettlementReports(app.context, new URLSearchParams())).results).toHaveLength(2);
    expect(failure(searchSettlementReports(app.context, new URLSearchParams({ begin_date: 'x' }))).status).toBe(400);

    const paged = body(searchSettlementReports(app.context, new URLSearchParams({ limit: '1', offset: '1' })));
    expect(paged.paging).toEqual({ total: 2, limit: 1, offset: 1 });
    expect(paged.results).toHaveLength(1);
    expect(body(getSettlementReport(app.context, new URLSearchParams({ limit: '1' }))).results).toHaveLength(1);
  });
});

describe('csv', () => {
  const row = (overrides: Partial<Row> = {}): Row => ({
    date: 1_700_000_000_000,
    source_id: 7,
    external_reference: null,
    transaction_type: 'SETTLEMENT',
    sign: 1,
    amount: 12_345,
    currency: 'BRL',
    payment_method_type: 'credit_card',
    payment_method: 'visa',
    installments: 3,
    settlement_date: 1_700_000_000_000,
    status: 'approved',
    status_detail: 'accredited',
    ...overrides,
  });

  test('quotes values carrying the separator, a quote or a newline', () => {
    const config = {
      ...DEFAULT_CONFIG,
      columns: [{ key: 'EXTERNAL_REFERENCE' as const, alias: null }],
    };
    const csv = renderCsv([row({ external_reference: 'a,b"c\nd' })], config);
    expect(csv).toBe('EXTERNAL_REFERENCE\r\n"a,b""c\nd"\r\n');

    const semi = renderCsv([row({ external_reference: 'a,b;c' })], { ...config, column_separator: ';' });
    expect(semi).toBe('EXTERNAL_REFERENCE\r\n"a,b;c"\r\n');
    // The comma is no longer the delimiter, so it needs no quoting.
    expect(renderCsv([row({ external_reference: 'a,b' })], { ...config, column_separator: ';' })).toBe(
      'EXTERNAL_REFERENCE\r\na,b\r\n',
    );
  });

  test('a tab separator survives an alias carrying a tab', () => {
    const config = {
      ...DEFAULT_CONFIG,
      column_separator: '\t' as const,
      columns: [
        { key: 'SOURCE_ID' as const, alias: 'id\there' },
        { key: 'TRANSACTION_AMOUNT' as const, alias: null },
      ],
    };
    expect(renderCsv([row()], config)).toBe('"id\there"\tTRANSACTION_AMOUNT\r\n7\t123.45\r\n');
  });

  test('renders the configured columns, aliases and time zone', () => {
    const app = harness();
    createSettlementReportConfig(app.context, {
      file_name_prefix: 'ledger',
      column_separator: ';',
      display_timezone: 'America/Sao_Paulo',
      columns: [{ key: 'DATE', alias: 'when' }, { key: 'TRANSACTION_AMOUNT' }],
    });
    pay(app.context);

    const report = generate(app);
    expect(report.fileName).toMatch(/^ledger-2020-01-01-2030-01-01-[0-9a-f]{32}\.csv$/);
    expect(report.header).toBe('when;TRANSACTION_AMOUNT');
    expect(report.rows[0]).toBe('2023-11-14T19:13:20-03:00;100.50');
  });
});
