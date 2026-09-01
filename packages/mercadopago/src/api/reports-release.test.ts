import { describe, expect, test } from 'bun:test';
import type { Result } from '@payground/core';
import type { ErrorBody } from '../errors.ts';
import type { ReportConfig, ReportListResult, ReportTask } from '../generated/types.ts';
import { testContext } from '../testing.ts';
import type { Rendered } from './context.ts';
import {
  REPORT_BUILD_MS,
  REPORT_QUEUE_MS,
  createReleaseReport,
  createReleaseReportConfig,
  disableReleaseReportSchedule,
  downloadReleaseReport,
  enableReleaseReportSchedule,
  escapeCsv,
  getReleaseReport,
  getReleaseReportConfig,
  getReleaseReportTask,
  listScheduledReleaseReports,
  searchReleaseReports,
  timezoneOffset,
} from './reports-release.ts';
import { seedLedger } from './reports-release.testing.ts';

const NOW = Date.UTC(2024, 2, 10, 15, 0, 0);
const DAY = 86_400_000;
const READY = REPORT_QUEUE_MS + REPORT_BUILD_MS;

const unwrap = <T>(result: Result<T, ErrorBody>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

const body = <T>(result: Result<Rendered, ErrorBody>): T => unwrap(result).body as T;

const parse = (csv: string, separator = ','): string[][] =>
  csv
    .trimEnd()
    .split('\n')
    .map((line) => line.split(separator));

function generated(entries: Parameters<typeof seedLedger>[1], range = { from: NOW - DAY, to: NOW + DAY }) {
  const harness = testContext(NOW);
  seedLedger(harness.context, entries);
  const task = body<ReportTask>(
    createReleaseReport(harness.context, {
      begin_date: new Date(range.from).toISOString(),
      end_date: new Date(range.to).toISOString(),
    }),
  );
  harness.clock.advance(READY);
  return { harness, task };
}

describe('csv escaping', () => {
  test('quotes the separator, quotes and newlines', () => {
    expect(escapeCsv('plain', ',')).toBe('plain');
    expect(escapeCsv('a,b', ',')).toBe('"a,b"');
    expect(escapeCsv('a,b', ';')).toBe('a,b');
    expect(escapeCsv('a"b', ',')).toBe('"a""b"');
    expect(escapeCsv('a\nb', ',')).toBe('"a\nb"');
    expect(escapeCsv('a\r\nb', ';')).toBe('"a\r\nb"');
  });
});

describe('display timezone', () => {
  test('parses the offsets the config accepts', () => {
    expect(timezoneOffset('UTC')).toBe(0);
    expect(timezoneOffset('GMT-03')).toBe(-180);
    expect(timezoneOffset('GMT+05:30')).toBe(330);
    expect(timezoneOffset('-0300')).toBe(-180);
    expect(timezoneOffset('America/Sao_Paulo')).toBeNull();
  });
});

describe('report configuration', () => {
  test('defaults expose every column', () => {
    const harness = testContext(NOW);
    const config = body<ReportConfig>(getReleaseReportConfig(harness.context));
    expect(config.columns?.length).toBe(15);
    expect(config.file_name_prefix).toBe('release-report');
    expect(config.separator).toBe(',');
  });

  test('rejects an unknown column, a bad prefix and a bad timezone', () => {
    const harness = testContext(NOW);
    expect(createReleaseReportConfig(harness.context, { columns: [{ key: 'NOPE' }] }).ok).toBe(false);
    expect(createReleaseReportConfig(harness.context, { file_name_prefix: '../etc/passwd' }).ok).toBe(false);
    expect(createReleaseReportConfig(harness.context, { display_timezone: 'Mars/Olympus' }).ok).toBe(false);
  });

  test('an update keeps the fields it does not mention', () => {
    const harness = testContext(NOW);
    createReleaseReportConfig(harness.context, { file_name_prefix: 'money', separator: ';' });
    const config = body<ReportConfig>(getReleaseReportConfig(harness.context));
    expect([config.file_name_prefix, config.separator]).toEqual(['money', ';']);
  });
});

describe('report generation', () => {
  test('the task walks pending, in_progress and done', () => {
    const harness = testContext(NOW);
    const created = body<ReportTask>(
      createReleaseReport(harness.context, {
        begin_date: new Date(NOW - DAY).toISOString(),
        end_date: new Date(NOW).toISOString(),
      }),
    );
    expect(created.status).toBe('pending');
    expect(created.download_url).toBeNull();

    harness.clock.advance(REPORT_QUEUE_MS);
    expect(body<ReportTask>(getReleaseReportTask(harness.context, created.id ?? '')).status).toBe('in_progress');

    harness.clock.advance(REPORT_BUILD_MS);
    const done = body<ReportTask>(getReleaseReportTask(harness.context, created.id ?? ''));
    expect(done.status).toBe('done');
    expect(done.download_url).toBe(`${harness.context.baseUrl}/v1/account/release_report/${done.file_name ?? ''}`);
  });

  test('rejects an inverted range and an unknown task', () => {
    const harness = testContext(NOW);
    expect(
      createReleaseReport(harness.context, {
        begin_date: new Date(NOW).toISOString(),
        end_date: new Date(NOW - DAY).toISOString(),
      }).ok,
    ).toBe(false);
    expect(getReleaseReportTask(harness.context, 'missing').ok).toBe(false);
  });

  test('the file is not downloadable before the task finishes', () => {
    const harness = testContext(NOW);
    const task = body<ReportTask>(
      createReleaseReport(harness.context, {
        begin_date: new Date(NOW - DAY).toISOString(),
        end_date: new Date(NOW).toISOString(),
      }),
    );
    expect(downloadReleaseReport(harness.context, task.file_name ?? '').ok).toBe(false);
    harness.clock.advance(READY);
    expect(downloadReleaseReport(harness.context, task.file_name ?? '').ok).toBe(true);
    expect(body<ReportListResult>(getReleaseReport(harness.context)).results?.length).toBe(1);
  });
});

describe('report content', () => {
  test('carries one release row per settled payment and one row per approved refund', () => {
    const { harness, task } = generated([
      { amount: 10_000, settledAt: NOW, description: 'order one', externalReference: 'ext-1' },
      { amount: 5_000, settledAt: NOW, refunds: [{ amount: 5_000, at: NOW }] },
      { amount: 7_000, settledAt: null },
      { amount: 3_000, settledAt: NOW, refunds: [{ amount: 1_000, at: NOW, approved: false }] },
    ]);
    const file = unwrap(downloadReleaseReport(harness.context, task.file_name ?? ''));
    const rows = parse(file.body);

    expect(rows[0]?.length).toBe(15);
    expect(rows[0]?.[0]).toBe('RELEASE_DATE');
    expect(rows.length).toBe(1 + 4);
    expect(rows.filter((row) => row[3] === 'refund').length).toBe(1);

    const first = rows[1] ?? [];
    // 10000 minor at 4.99% = 499 minor of fee, so 95.01 is released.
    expect([first[1], first[2], first[4], first[5], first[7], first[8]]).toEqual([
      '1',
      'ext-1',
      'order one',
      '100.00',
      '100.00',
      '0.00',
    ]);
  });

  test('a generated file is frozen: later payments and config changes do not change it', () => {
    const { harness, task } = generated([{ amount: 1_000, settledAt: NOW }]);
    const before = unwrap(downloadReleaseReport(harness.context, task.file_name ?? '')).body;

    seedLedger(harness.context, [{ amount: 9_000, settledAt: NOW }]);
    createReleaseReportConfig(harness.context, { separator: ';' });
    expect(unwrap(downloadReleaseReport(harness.context, task.file_name ?? '')).body).toBe(before);
  });

  test('excludes payments released outside the range', () => {
    const { harness, task } = generated(
      [
        { amount: 1_000, settledAt: NOW - 10 * DAY },
        { amount: 2_000, settledAt: NOW },
      ],
      { from: NOW - DAY, to: NOW + DAY },
    );
    const rows = parse(unwrap(downloadReleaseReport(harness.context, task.file_name ?? '')).body);
    expect(rows.length).toBe(2);
    expect(rows[1]?.[7]).toBe('20.00');
  });

  test('honours the configured columns, separator, prefix and timezone', () => {
    const harness = testContext(NOW);
    seedLedger(harness.context, [{ amount: 1_000, settledAt: NOW, description: 'a;b"c' }]);
    createReleaseReportConfig(harness.context, {
      columns: [{ key: 'SOURCE_ID', alias: 'id' }, { key: 'DESCRIPTION' }, { key: 'RELEASE_DATE' }],
      separator: ';',
      file_name_prefix: 'money',
      display_timezone: 'UTC',
    });
    const task = body<ReportTask>(
      createReleaseReport(harness.context, {
        begin_date: new Date(NOW - DAY).toISOString(),
        end_date: new Date(NOW + DAY).toISOString(),
      }),
    );
    harness.clock.advance(READY);

    const file = unwrap(downloadReleaseReport(harness.context, task.file_name ?? ''));
    expect(file.fileName.startsWith('money-')).toBe(true);
    const lines = file.body.trimEnd().split('\n');
    expect(lines[0]).toBe('id;DESCRIPTION;RELEASE_DATE');
    // The description holds the separator and a quote, so it is quoted and the quote doubled.
    expect(lines[1]).toBe('1;"a;b""c";2024-03-10T15:00:00.000+00:00');
  });

  test('no fee is charged, so net always equals gross', () => {
    const { harness, task } = generated([{ amount: 10_000, settledAt: NOW, installments: 4 }]);
    const rows = parse(unwrap(downloadReleaseReport(harness.context, task.file_name ?? '')).body);
    // GET /v1/payments/{id} reports fee_details: [] and net_amount == gross; the report agrees.
    expect([rows[1]?.[8], rows[1]?.[9], rows[1]?.[5]]).toEqual(['0.00', '0.00', '100.00']);
  });
});

describe('search and scheduling', () => {
  test('search filters by overlapping range', () => {
    const harness = testContext(NOW);
    createReleaseReport(harness.context, {
      begin_date: new Date(NOW - 2 * DAY).toISOString(),
      end_date: new Date(NOW - DAY).toISOString(),
    });
    harness.clock.advance(READY);

    const inside = body<ReportListResult>(
      searchReleaseReports(harness.context, new URLSearchParams({ begin_date: new Date(NOW - 3 * DAY).toISOString() })),
    );
    expect(inside.results?.length).toBe(1);

    const outside = body<ReportListResult>(
      searchReleaseReports(harness.context, new URLSearchParams({ begin_date: new Date(NOW).toISOString() })),
    );
    expect(outside.results?.length).toBe(0);
    expect(searchReleaseReports(harness.context, new URLSearchParams({ begin_date: 'nope' })).ok).toBe(false);
  });

  test('enable, list and disable the schedule', () => {
    const harness = testContext(NOW);
    expect(body<ReportListResult>(listScheduledReleaseReports(harness.context)).results).toEqual([]);

    enableReleaseReportSchedule(harness.context, { frequency: { type: 'weekly', hour: 7 } });
    const listed = body<ReportListResult>(listScheduledReleaseReports(harness.context));
    expect(listed.results?.[0]?.frequency).toEqual({ hour: 7, type: 'weekly' });
    expect(listed.results?.[0]?.enabled).toBe(true);

    expect(enableReleaseReportSchedule(harness.context, { frequency: { hour: 99 } }).ok).toBe(false);
    // An empty body is what most clients send for a POST with no documented request schema.
    expect(enableReleaseReportSchedule(harness.context, {}).ok).toBe(true);
    expect(body<ReportConfig>(getReleaseReportConfig(harness.context)).frequency).toEqual({ hour: 7, type: 'weekly' });

    // Replacing the configuration does not silently switch the schedule off.
    createReleaseReportConfig(harness.context, { separator: ';' });
    expect(body<ReportListResult>(listScheduledReleaseReports(harness.context)).results).toHaveLength(1);

    disableReleaseReportSchedule(harness.context);
    expect(body<ReportListResult>(listScheduledReleaseReports(harness.context)).results).toEqual([]);
  });
});
