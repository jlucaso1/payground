import {
  type JsonObject,
  type Minor,
  type Payment,
  type PaymentMethodKind,
  type Result,
  type StoredDocument,
  err,
  ok,
  toDecimal,
} from '@payground/core';
import { type ErrorBody, badRequest, notFound } from '../errors.ts';
import type { ReportConfig, ReportEntry, ReportListResult, ReportTask } from '../generated/types.ts';
import { validateReportConfig, validateReportRequest } from '../generated/validate.ts';
import { compact } from '../serialize/compact.ts';
import { formatDateTime } from '../serialize/datetime.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { readNumber, readObject, readString } from './document.ts';

/* ---------------------------------------------------------------- columns */

export const RELEASE_COLUMNS = [
  'RELEASE_DATE',
  'SOURCE_ID',
  'EXTERNAL_REFERENCE',
  'RECORD_TYPE',
  'DESCRIPTION',
  'NET_CREDIT_AMOUNT',
  'NET_DEBIT_AMOUNT',
  'GROSS_AMOUNT',
  'MP_FEE_AMOUNT',
  'FINANCING_FEE_AMOUNT',
  'SHIPPING_FEE_AMOUNT',
  'TAXES_AMOUNT',
  'COUPON_AMOUNT',
  'INSTALLMENTS',
  'PAYMENT_METHOD',
] as const;

export type ReleaseColumn = (typeof RELEASE_COLUMNS)[number];

const isColumn = (value: string): value is ReleaseColumn =>
  (RELEASE_COLUMNS as readonly string[]).includes(value);

export interface ReleaseRow {
  releaseAt: number;
  sourceId: string;
  externalReference: string;
  recordType: 'release' | 'refund';
  description: string;
  netCredit: Minor;
  netDebit: Minor;
  gross: Minor;
  mpFee: Minor;
  financingFee: Minor;
  shippingFee: Minor;
  taxes: Minor;
  coupon: Minor;
  installments: number;
  paymentMethod: string;
}

/* ------------------------------------------------------------------- fees */

/**
 * Mercado Pago publishes its rates commercially, not in the OpenAPI spec, so payground uses
 * a fixed basis-point table per payment type. What matters for a staging environment is that
 * every row reconciles exactly: net = gross - fees, computed in minor units only.
 * https://www.mercadopago.com.br/costs-section/release-options
 */
const FEE_BPS: Record<PaymentMethodKind, number> = {
  card: 499,
  bank_transfer: 99,
  voucher: 349,
  wallet: 499,
};

const FINANCING_BPS_PER_INSTALLMENT = 100;

const applyBps = (gross: Minor, bps: number): Minor => Math.floor((gross * bps) / 10_000) as Minor;

/* ----------------------------------------------------------------- config */

interface ColumnChoice {
  key: ReleaseColumn;
  alias: string;
}

type Frequency = { hour: number; type: 'daily' | 'weekly' | 'monthly' };

export interface Config {
  columns: ColumnChoice[] | null;
  filePrefix: string;
  frequency: Frequency;
  sftp: JsonObject | null;
  separator: string;
  timezone: string;
  emails: string[];
  scheduled: boolean;
}

const CONFIG_ID = 'release';
const DEFAULT_PREFIX = 'release-report';
const DEFAULT_TIMEZONE = 'GMT-03';
const DEFAULT_FREQUENCY: Frequency = { hour: 0, type: 'daily' };

const DEFAULT_CONFIG: Config = {
  columns: null,
  filePrefix: DEFAULT_PREFIX,
  frequency: DEFAULT_FREQUENCY,
  sftp: null,
  separator: ',',
  timezone: DEFAULT_TIMEZONE,
  emails: [],
  scheduled: false,
};

/** The prefix ends up in a file name and in a content-disposition header. */
const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Accepts `UTC`, `GMT-03`, `GMT+05:30` and bare offsets such as `-03:00`. */
export function timezoneOffset(zone: string): number | null {
  const trimmed = zone.trim();
  if (trimmed === 'UTC' || trimmed === 'GMT' || trimmed === 'Z') return 0;
  const match = /^(?:GMT|UTC)?([+-])(\d{2}):?(\d{2})?$/.exec(trimmed);
  if (match === null) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? '0');
  if (hours > 14 || minutes > 59) return null;
  return (match[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
}

function parseConfig(body: unknown, current: Config): Result<Config, ErrorBody> {
  const validated = validateReportConfig(body ?? {});
  if (!validated.ok) {
    return err(
      badRequest(
        'invalid parameters',
        validated.error.map((issue) => ({ code: 2034, description: `${issue.path}: ${issue.message}` })),
      ),
    );
  }
  const request = validated.value;

  let columns: ColumnChoice[] | null = current.columns;
  if (request.columns !== undefined) {
    const chosen: ColumnChoice[] = [];
    for (const entry of request.columns) {
      const key = entry.key;
      if (key === undefined || !isColumn(key)) {
        return err(badRequest('invalid parameters', [{ code: 2034, description: `unknown column: ${key ?? ''}` }]));
      }
      chosen.push({ key, alias: entry.alias ?? key });
    }
    if (chosen.length === 0) {
      return err(badRequest('invalid parameters', [{ code: 2034, description: 'columns must not be empty' }]));
    }
    columns = chosen;
  }

  const filePrefix = request.file_name_prefix ?? current.filePrefix;
  if (!PREFIX_PATTERN.test(filePrefix)) {
    return err(
      badRequest('invalid parameters', [{ code: 2034, description: 'file_name_prefix must match [A-Za-z0-9_-]' }]),
    );
  }

  const timezone = request.display_timezone ?? current.timezone;
  if (timezoneOffset(timezone) === null) {
    return err(badRequest('invalid parameters', [{ code: 2034, description: `unknown display_timezone: ${timezone}` }]));
  }

  const frequency = request.frequency;
  const hour = frequency?.hour ?? current.frequency.hour;
  if (hour < 0 || hour > 23) {
    return err(badRequest('invalid parameters', [{ code: 2034, description: 'frequency.hour must be 0..23' }]));
  }

  const separator = request.separator === undefined || request.separator === '' ? current.separator : request.separator;

  return ok({
    columns,
    filePrefix,
    frequency: { hour, type: frequency?.type ?? current.frequency.type },
    sftp: request.sftp_info === undefined ? current.sftp : (request.sftp_info as JsonObject),
    separator,
    timezone,
    emails: request.notification_email_list ?? current.emails,
    scheduled: current.scheduled,
  });
}

function readConfigDoc(doc: JsonObject): Config {
  const rawColumns = doc['columns'];
  const columns = Array.isArray(rawColumns)
    ? rawColumns.flatMap((entry): ColumnChoice[] => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
        const key = readString(entry as JsonObject, 'key');
        if (key === null || !isColumn(key)) return [];
        return [{ key, alias: readString(entry as JsonObject, 'alias') ?? key }];
      })
    : null;
  const frequency = readObject(doc, 'frequency');
  const type = readString(frequency, 'type');
  const emails = doc['notification_email_list'];

  return {
    columns,
    filePrefix: readString(doc, 'file_name_prefix') ?? DEFAULT_PREFIX,
    frequency: {
      hour: readNumber(frequency, 'hour') ?? DEFAULT_FREQUENCY.hour,
      type: type === 'weekly' || type === 'monthly' ? type : 'daily',
    },
    sftp: doc['sftp_info'] === undefined || doc['sftp_info'] === null ? null : readObject(doc, 'sftp_info'),
    separator: readString(doc, 'separator') ?? ',',
    timezone: readString(doc, 'display_timezone') ?? DEFAULT_TIMEZONE,
    emails: Array.isArray(emails) ? emails.filter((value): value is string => typeof value === 'string') : [],
    scheduled: doc['scheduled'] === true,
  };
}

const toConfigDoc = (config: Config): JsonObject => ({
  columns: config.columns === null ? null : config.columns.map((column) => ({ ...column })),
  file_name_prefix: config.filePrefix,
  frequency: { ...config.frequency },
  sftp_info: config.sftp,
  separator: config.separator,
  display_timezone: config.timezone,
  notification_email_list: [...config.emails],
  scheduled: config.scheduled,
});

const serializeConfig = (config: Config): ReportConfig =>
  compact<ReportConfig>({
    columns: (config.columns ?? RELEASE_COLUMNS.map((key) => ({ key, alias: key }))).map((column) => ({ ...column })),
    file_name_prefix: config.filePrefix,
    frequency: { ...config.frequency },
    ...(config.sftp === null ? {} : { sftp_info: config.sftp as ReportConfig['sftp_info'] }),
    separator: config.separator === ';' ? ';' : ',',
    display_timezone: config.timezone,
    notification_email_list: [...config.emails],
  });

function loadConfig(context: ServiceContext): { config: Config; document: StoredDocument | null } {
  const document = context.store.documents.get('report_config', CONFIG_ID);
  return { config: document === null ? DEFAULT_CONFIG : readConfigDoc(document.doc), document };
}

function saveConfig(context: ServiceContext, config: Config): void {
  const now = context.clock.now();
  const existing = context.store.documents.get('report_config', CONFIG_ID);
  const document: StoredDocument = {
    kind: 'report_config',
    id: CONFIG_ID,
    sequence: existing?.sequence ?? context.store.nextSequence('report_config'),
    status: config.scheduled ? 'scheduled' : 'manual',
    externalReference: null,
    lookup: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    expiresAt: null,
    doc: toConfigDoc(config),
  };
  if (existing === null) context.store.documents.insert(document);
  else context.store.documents.update(document);
}

/* ------------------------------------------------------------------- rows */

const pageSize = 500;

function allPayments(context: ServiceContext): Payment[] {
  const out: Payment[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = context.store.payments.search({ limit: pageSize, offset, order: 'asc' });
    out.push(...page.results);
    if (page.results.length === 0 || out.length >= page.total) break;
  }
  return out;
}

/** Every row is derived from a stored payment or refund; nothing is synthesised. */
export function buildRows(context: ServiceContext, beginAt: number, endAt: number): ReleaseRow[] {
  const rows: ReleaseRow[] = [];
  const within = (at: number): boolean => at >= beginAt && at <= endAt;

  for (const payment of allPayments(context)) {
    const sourceId = String(context.store.payments.sequenceOf(payment.id) ?? 0);
    const externalReference = payment.externalReference ?? '';

    if (payment.settledAt !== null && within(payment.settledAt)) {
      const gross = payment.capturedAmount;
      const mpFee = applyBps(gross, FEE_BPS[payment.method.kind]);
      const financingFee = applyBps(gross, Math.max(payment.installments - 1, 0) * FINANCING_BPS_PER_INSTALLMENT);
      rows.push({
        releaseAt: payment.settledAt,
        sourceId,
        externalReference,
        recordType: 'release',
        description: payment.description ?? '',
        netCredit: (gross - mpFee - financingFee) as Minor,
        netDebit: 0 as Minor,
        gross,
        mpFee,
        financingFee,
        shippingFee: 0 as Minor,
        taxes: 0 as Minor,
        coupon: 0 as Minor,
        installments: payment.installments,
        paymentMethod: payment.method.code,
      });
    }

    for (const refund of context.store.refunds.listFor(payment.id)) {
      if (refund.status !== 'approved' || !within(refund.createdAt)) continue;
      rows.push({
        releaseAt: refund.createdAt,
        sourceId,
        externalReference,
        recordType: 'refund',
        description: payment.description ?? '',
        netCredit: 0 as Minor,
        netDebit: refund.amount,
        gross: refund.amount,
        mpFee: 0 as Minor,
        financingFee: 0 as Minor,
        shippingFee: 0 as Minor,
        taxes: 0 as Minor,
        coupon: 0 as Minor,
        installments: payment.installments,
        paymentMethod: payment.method.code,
      });
    }
  }

  rows.sort(
    (a, b) =>
      a.releaseAt - b.releaseAt ||
      Number(a.sourceId) - Number(b.sourceId) ||
      a.recordType.localeCompare(b.recordType),
  );
  return rows;
}

/* -------------------------------------------------------------------- csv */

const money = (value: Minor): string => toDecimal(value).toFixed(2);

function cell(row: ReleaseRow, column: ReleaseColumn, offsetMinutes: number): string {
  switch (column) {
    case 'RELEASE_DATE':
      return formatDateTime(row.releaseAt, offsetMinutes);
    case 'SOURCE_ID':
      return row.sourceId;
    case 'EXTERNAL_REFERENCE':
      return row.externalReference;
    case 'RECORD_TYPE':
      return row.recordType;
    case 'DESCRIPTION':
      return row.description;
    case 'NET_CREDIT_AMOUNT':
      return money(row.netCredit);
    case 'NET_DEBIT_AMOUNT':
      return money(row.netDebit);
    case 'GROSS_AMOUNT':
      // A refund debits the account, so the column stays summable on its own.
      return row.recordType === 'refund' ? `-${money(row.gross)}` : money(row.gross);
    case 'MP_FEE_AMOUNT':
      return money(row.mpFee);
    case 'FINANCING_FEE_AMOUNT':
      return money(row.financingFee);
    case 'SHIPPING_FEE_AMOUNT':
      return money(row.shippingFee);
    case 'TAXES_AMOUNT':
      return money(row.taxes);
    case 'COUPON_AMOUNT':
      return money(row.coupon);
    case 'INSTALLMENTS':
      return String(row.installments);
    case 'PAYMENT_METHOD':
      return row.paymentMethod;
  }
}

export function escapeCsv(value: string, separator: string): string {
  const needsQuotes =
    value.includes(separator) || value.includes('"') || value.includes('\n') || value.includes('\r');
  return needsQuotes ? `"${value.replaceAll('"', '""')}"` : value;
}

export function renderCsv(rows: readonly ReleaseRow[], config: Config): string {
  const columns = config.columns ?? RELEASE_COLUMNS.map((key) => ({ key, alias: key }));
  const offset = timezoneOffset(config.timezone) ?? 0;
  const separator = config.separator;
  const lines = [columns.map((column) => escapeCsv(column.alias, separator)).join(separator)];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsv(cell(row, column.key, offset), separator)).join(separator));
  }
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ tasks */

/** A generated file spends this long queued, then this long being written. */
export const REPORT_QUEUE_MS = 1_000;
export const REPORT_BUILD_MS = 5_000;

type TaskStatus = NonNullable<ReportTask['status']>;

interface ReportDoc {
  fileName: string;
  content: string;
  beginDate: string;
  endDate: string;
  beginAt: number;
  endAt: number;
  readyAt: number;
  taskId: string;
}

function readReport(document: StoredDocument): ReportDoc {
  const doc = document.doc;
  return {
    fileName: readString(doc, 'file_name') ?? '',
    content: readString(doc, 'content') ?? '',
    beginDate: readString(doc, 'begin_date') ?? '',
    endDate: readString(doc, 'end_date') ?? '',
    beginAt: readNumber(doc, 'begin_at') ?? 0,
    endAt: readNumber(doc, 'end_at') ?? 0,
    readyAt: readNumber(doc, 'ready_at') ?? 0,
    taskId: readString(doc, 'task_id') ?? '',
  };
}

function taskStatus(createdAt: number, readyAt: number, now: number): TaskStatus {
  if (now >= readyAt) return 'done';
  return now < createdAt + REPORT_QUEUE_MS ? 'pending' : 'in_progress';
}

function serializeTask(context: ServiceContext, document: StoredDocument, taskId: string): ReportTask {
  const report = readReport(document);
  const now = context.clock.now();
  const status = taskStatus(document.createdAt, report.readyAt, now);
  return compact<ReportTask>({
    id: taskId,
    status,
    begin_date: report.beginDate,
    end_date: report.endDate,
    created_at: formatDateTime(document.createdAt),
    updated_at: formatDateTime(Math.min(now, report.readyAt)),
    file_name: report.fileName,
    download_url:
      status === 'done' ? `${context.baseUrl}/v1/account/release_report/${report.fileName}` : null,
  });
}

function serializeEntry(document: StoredDocument): ReportEntry {
  const report = readReport(document);
  return compact<ReportEntry>({
    id: document.id,
    status: 'available',
    date_created: formatDateTime(document.createdAt),
    date_last_updated: formatDateTime(report.readyAt),
    begin_date: report.beginDate,
    end_date: report.endDate,
    file_name: report.fileName,
  });
}

function finishedReports(context: ServiceContext): StoredDocument[] {
  const now = context.clock.now();
  const out: StoredDocument[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = context.store.documents.search('report', { limit: pageSize, offset, order: 'asc' });
    out.push(...page.results);
    if (page.results.length === 0 || out.length >= page.total) break;
  }
  return out.filter((document) => now >= readReport(document).readyAt);
}

const listing = (entries: readonly ReportEntry[]): ReportListResult => ({
  paging: { total: entries.length, limit: entries.length, offset: 0 },
  results: [...entries],
});

/* ------------------------------------------------------------ operations */

export function getReleaseReportConfig(context: ServiceContext): Result<Rendered, ErrorBody> {
  return ok({ status: 200, body: serializeConfig(loadConfig(context).config) });
}

export function createReleaseReportConfig(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  // POST replaces the configuration, but schedule enablement is separate state.
  const parsed = parseConfig(body, { ...DEFAULT_CONFIG, scheduled: loadConfig(context).config.scheduled });
  if (!parsed.ok) return parsed;
  saveConfig(context, parsed.value);
  return ok({ status: 200, body: serializeConfig(parsed.value) });
}

export function updateReleaseReportConfig(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  const parsed = parseConfig(body, loadConfig(context).config);
  if (!parsed.ok) return parsed;
  saveConfig(context, parsed.value);
  return ok({ status: 200, body: serializeConfig(parsed.value) });
}

const stamp = (at: number, offsetMinutes: number): string =>
  formatDateTime(at, offsetMinutes).slice(0, 19).replaceAll(/[-:]/g, '').replace('T', '-');

function parseRange(body: unknown): Result<{ beginDate: string; endDate: string; beginAt: number; endAt: number }, ErrorBody> {
  const validated = validateReportRequest(body);
  if (!validated.ok) {
    return err(
      badRequest(
        'invalid parameters',
        validated.error.map((issue) => ({ code: 2034, description: `${issue.path}: ${issue.message}` })),
      ),
    );
  }
  const beginAt = Date.parse(validated.value.begin_date);
  const endAt = Date.parse(validated.value.end_date);
  if (Number.isNaN(beginAt) || Number.isNaN(endAt)) {
    return err(badRequest('invalid parameters', [{ code: 2034, description: 'begin_date and end_date must be dates' }]));
  }
  if (beginAt > endAt) {
    return err(badRequest('invalid parameters', [{ code: 2034, description: 'begin_date must not be after end_date' }]));
  }
  return ok({ beginDate: validated.value.begin_date, endDate: validated.value.end_date, beginAt, endAt });
}

export function createReleaseReport(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  const range = parseRange(body);
  if (!range.ok) return range;

  const { config } = loadConfig(context);
  const now = context.clock.now();
  const sequence = context.store.nextSequence('report');
  const fileName = `${config.filePrefix}-${stamp(now, timezoneOffset(config.timezone) ?? 0)}-${sequence}.csv`;
  const reportId = context.ids.uuid();
  const taskId = context.ids.uuid();

  context.store.documents.insert({
    kind: 'report',
    id: reportId,
    sequence,
    status: 'available',
    externalReference: null,
    lookup: fileName,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    doc: {
      file_name: fileName,
      // The file is frozen when it is requested, so the same URL always returns the same bytes.
      content: renderCsv(buildRows(context, range.value.beginAt, range.value.endAt), config),
      begin_date: range.value.beginDate,
      end_date: range.value.endDate,
      begin_at: range.value.beginAt,
      end_at: range.value.endAt,
      ready_at: now + REPORT_QUEUE_MS + REPORT_BUILD_MS,
      task_id: taskId,
    },
  });

  context.store.documents.insert({
    kind: 'report_task',
    id: taskId,
    sequence: context.store.nextSequence('report_task'),
    status: 'pending',
    externalReference: null,
    lookup: reportId,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    doc: { report_id: reportId },
  });

  const report = context.store.documents.get('report', reportId);
  if (report === null) return err(notFound('Report not found'));
  return ok({ status: 202, body: serializeTask(context, report, taskId) });
}

export function getReleaseReportTask(context: ServiceContext, taskId: string): Result<Rendered, ErrorBody> {
  const task = context.store.documents.get('report_task', taskId);
  if (task === null) return err(notFound('Report task not found'));
  const report = context.store.documents.get('report', readString(task.doc, 'report_id') ?? '');
  if (report === null) return err(notFound('Report not found'));
  return ok({ status: 200, body: serializeTask(context, report, taskId) });
}

export function getReleaseReport(context: ServiceContext): Result<Rendered, ErrorBody> {
  return ok({ status: 200, body: listing(finishedReports(context).map(serializeEntry)) });
}

export function searchReleaseReports(
  context: ServiceContext,
  params: URLSearchParams,
): Result<Rendered, ErrorBody> {
  const bounds: { begin: number | null; end: number | null } = { begin: null, end: null };
  for (const name of ['begin_date', 'end_date'] as const) {
    const raw = params.get(name);
    if (raw === null || raw === '') continue;
    const at = Date.parse(raw);
    if (Number.isNaN(at)) {
      return err(badRequest('invalid parameters', [{ code: 2034, description: `${name} must be a date` }]));
    }
    if (name === 'begin_date') bounds.begin = at;
    else bounds.end = at;
  }

  // A report matches when its covered range overlaps the queried one.
  const matching = finishedReports(context).filter((document) => {
    const report = readReport(document);
    if (bounds.begin !== null && report.endAt < bounds.begin) return false;
    if (bounds.end !== null && report.beginAt > bounds.end) return false;
    return true;
  });
  return ok({ status: 200, body: listing(matching.map(serializeEntry)) });
}

function parseFrequency(body: unknown, current: Frequency): Result<Frequency, ErrorBody> {
  if (body === undefined || body === null) return ok(current);
  const validated = validateReportConfig(body);
  if (!validated.ok) {
    return err(badRequest('invalid parameters', [{ code: 2034, description: 'frequency must be {type, hour}' }]));
  }
  if (validated.value.frequency === undefined) return ok(current);
  const { hour, type } = validated.value.frequency;
  if (hour !== undefined && (hour < 0 || hour > 23)) {
    return err(badRequest('invalid parameters', [{ code: 2034, description: 'frequency.hour must be 0..23' }]));
  }
  return ok({ hour: hour ?? current.hour, type: type ?? current.type });
}

const scheduleEntry = (config: Config, document: StoredDocument | null): ReportEntry =>
  compact<ReportEntry>({
    id: CONFIG_ID,
    status: 'available',
    file_name: `${config.filePrefix}.csv`,
    frequency: { ...config.frequency },
    enabled: true,
    ...(document === null
      ? {}
      : {
          date_created: formatDateTime(document.createdAt),
          date_last_updated: formatDateTime(document.updatedAt),
        }),
  });

export function enableReleaseReportSchedule(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  const { config } = loadConfig(context);
  const frequency = parseFrequency(body, config.frequency);
  if (!frequency.ok) return frequency;
  saveConfig(context, { ...config, frequency: frequency.value, scheduled: true });
  const stored = loadConfig(context);
  return ok({ status: 200, body: scheduleEntry(stored.config, stored.document) });
}

export function disableReleaseReportSchedule(context: ServiceContext): Result<Rendered, ErrorBody> {
  const { config } = loadConfig(context);
  saveConfig(context, { ...config, scheduled: false });
  return ok({ status: 200, body: serializeConfig(config) });
}

export function listScheduledReleaseReports(context: ServiceContext): Result<Rendered, ErrorBody> {
  const { config, document } = loadConfig(context);
  return ok({ status: 200, body: listing(config.scheduled ? [scheduleEntry(config, document)] : []) });
}

export interface ReportFile {
  fileName: string;
  contentType: string;
  body: string;
}

export function downloadReleaseReport(context: ServiceContext, fileName: string): Result<ReportFile, ErrorBody> {
  const document = context.store.documents.byLookup('report', fileName);
  if (document === null) return err(notFound('Report not found'));
  const report = readReport(document);
  if (context.clock.now() < report.readyAt) return err(notFound('Report is still being generated'));

  return ok({ fileName: report.fileName, contentType: 'text/csv; charset=utf-8', body: report.content });
}
