import {
  type JsonObject,
  type JsonValue,
  type Minor,
  type Payment,
  type Result,
  type StoredDocument,
  err,
  isJsonObject,
  ok,
  toDecimal,
} from '@payground/core';
import { type ErrorBody, badRequest, notFound } from '../errors.ts';
import type { ReportConfig, ReportEntry, ReportTask } from '../generated/types.ts';
import { validateReportConfig, validateReportRequest } from '../generated/validate.ts';
import { paymentTypeId, providerStatus } from '../mapping/status.ts';
import { compact } from '../serialize/compact.ts';
import { formatDateTime } from '../serialize/datetime.ts';
import type { Rendered, ServiceContext } from './context.ts';

/* ------------------------------------------------------------------ model */

/**
 * Transaction-level columns of the settlement report, in the order the real file emits them.
 * https://www.mercadopago.com.br/developers/en/docs/your-integrations/reports/settlement-report/columns
 */
const COLUMNS = [
  'DATE',
  'SOURCE_ID',
  'EXTERNAL_REFERENCE',
  'TRANSACTION_TYPE',
  'TRANSACTION_AMOUNT',
  'TRANSACTION_CURRENCY',
  'SETTLEMENT_NET_AMOUNT',
  'MP_FEE_AMOUNT',
  'FINANCING_FEE_AMOUNT',
  'TAXES_AMOUNT',
  'PAYMENT_METHOD_TYPE',
  'PAYMENT_METHOD',
  'INSTALLMENTS',
  'SETTLEMENT_DATE',
  'STATUS',
  'STATUS_DETAIL',
] as const;

type ColumnKey = (typeof COLUMNS)[number];

type TransactionType = 'SETTLEMENT' | 'REFUND' | 'CHARGEBACK';

/** One money movement. Amounts are minor units; `sign` is -1 for money leaving the account. */
export interface Row {
  date: number;
  source_id: number;
  external_reference: string | null;
  transaction_type: TransactionType;
  sign: 1 | -1;
  amount: number;
  currency: string;
  payment_method_type: string;
  payment_method: string;
  installments: number;
  settlement_date: number | null;
  status: string;
  status_detail: string;
}

interface Column {
  key: ColumnKey;
  alias: string | null;
}

type Separator = ',' | ';' | '\t';

interface Frequency {
  type: 'daily' | 'weekly' | 'monthly';
  hour: number;
}

export interface ConfigDoc {
  file_name_prefix: string;
  column_separator: Separator;
  display_timezone: string;
  columns: Column[];
  notification_email_list: string[];
  sftp_info: JsonValue;
  scheduled: boolean;
  frequency: Frequency | null;
}

/** Holds the rendered file. Only ever read by a download, so the CSV is never parsed for a list. */
interface ReportDoc {
  task_id: string;
  config: ConfigDoc;
  content: string;
}

interface TaskDoc {
  report_id: string;
  begin: number;
  end: number;
  file_name: string;
}

type TaskStatus = NonNullable<ReportTask['status']>;

const CONFIG_ID = 'settlement-report-config';
const PREFIX = 'settlement-';

/** Generation is asynchronous: a task queues, then generates, then the file exists. */
const QUEUED_MS = 1_000;
const GENERATING_MS = 5_000;

const ROW_CAP = 50_000;
const PAGE = 1_000;

export const DEFAULT_CONFIG: ConfigDoc = {
  file_name_prefix: 'settlement-report',
  column_separator: ',',
  display_timezone: 'UTC',
  columns: COLUMNS.map((key) => ({ key, alias: null })),
  notification_email_list: [],
  sftp_info: null,
  scheduled: false,
  frequency: null,
};

const CODE = 2034;
const invalid = (description: string): ErrorBody =>
  badRequest('invalid parameters', [{ code: CODE, description }]);

const issues = (list: readonly { path: string; message: string }[]): ErrorBody =>
  badRequest(
    'invalid parameters',
    list.map((issue) => ({ code: CODE, description: `${issue.path}: ${issue.message}` })),
  );

const asJson = (value: ConfigDoc | ReportDoc | TaskDoc): JsonObject => value as unknown as JsonObject;
const readConfig = (document: StoredDocument): ConfigDoc => document.doc as unknown as ConfigDoc;
const readReport = (document: StoredDocument): ReportDoc => document.doc as unknown as ReportDoc;
const readTask = (document: StoredDocument): TaskDoc => document.doc as unknown as TaskDoc;

const resourceId = (uuid: string): string => uuid.replaceAll('-', '');

/* ------------------------------------------------------------------ dates */

const isZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/**
 * CSV timestamps are rendered in the configured IANA zone, which is what `display_timezone`
 * controls on the real report. `longOffset` yields `GMT-03:00`, or a bare `GMT` at UTC.
 */
function formatInZone(epochMs: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'longOffset',
  }).formatToParts(epochMs);

  const field = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const offset = field('timeZoneName').replace('GMT', '');

  return (
    `${field('year')}-${field('month')}-${field('day')}` +
    `T${field('hour')}:${field('minute')}:${field('second')}${offset === '' ? '+00:00' : offset}`
  );
}

const ymd = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

function parseDate(value: string, field: string): Result<number, ErrorBody> {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? err(invalid(`${field} must be an ISO 8601 date-time`)) : ok(parsed);
}

const DAY_MS = 86_400_000;

function offsetMinutes(epochMs: number, zone: string): number {
  const label = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(epochMs)
    .find((part) => part.type === 'timeZoneName')?.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(label ?? '');
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * Next run of a schedule. `frequency.hour` is an hour of the day in `display_timezone`, so the
 * arithmetic happens on the local calendar and is converted back, correcting once for a
 * daylight-saving shift between the guess and the answer.
 */
function nextExecution(frequency: Frequency, zone: string, now: number): number {
  const local = new Date(now + offsetMinutes(now, zone) * 60_000);
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), frequency.hour);

  let target: number;
  if (frequency.type === 'daily') target = day > local.getTime() ? day : day + DAY_MS;
  else if (frequency.type === 'weekly') {
    // Weekly reports run on Monday.
    const candidate = day + ((8 - local.getUTCDay()) % 7) * DAY_MS;
    target = candidate > local.getTime() ? candidate : candidate + 7 * DAY_MS;
  } else {
    const first = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1, frequency.hour);
    target =
      first > local.getTime()
        ? first
        : Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1, frequency.hour);
  }

  const guess = target - offsetMinutes(now, zone) * 60_000;
  return target - offsetMinutes(guess, zone) * 60_000;
}

/* ------------------------------------------------------------------ config */

function configDocument(context: ServiceContext): StoredDocument | null {
  return context.store.documents.get('report_config', CONFIG_ID);
}

const currentConfig = (context: ServiceContext): ConfigDoc => {
  const document = configDocument(context);
  return document === null ? DEFAULT_CONFIG : readConfig(document);
};

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const SEPARATORS: readonly Separator[] = [',', ';', '\t'];

const isSeparator = (value: string): value is Separator => (SEPARATORS as readonly string[]).includes(value);

function parseConfig(body: unknown, base: ConfigDoc): Result<ConfigDoc, ErrorBody> {
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));
  const validated = validateReportConfig(body);
  if (!validated.ok) return err(issues(validated.error));
  const wire = validated.value;

  const prefix = wire.file_name_prefix ?? base.file_name_prefix;
  if (!NAME.test(prefix)) {
    return err(invalid('file_name_prefix must match [A-Za-z0-9_-]{1,40}'));
  }

  const rawSeparator = body['column_separator'] ?? wire.separator;
  if (rawSeparator !== undefined && typeof rawSeparator !== 'string') {
    return err(invalid('column_separator must be a string'));
  }
  const raw = rawSeparator === undefined || rawSeparator === '' ? base.column_separator : rawSeparator;
  if (!isSeparator(raw)) return err(invalid('column_separator must be one of , ; or a tab'));
  const separator: Separator = raw;

  const zone = wire.display_timezone ?? base.display_timezone;
  if (!isZone(zone)) return err(invalid('display_timezone must be an IANA time zone'));

  let columns = base.columns;
  if (wire.columns !== undefined) {
    if (wire.columns.length === 0) return err(invalid('columns must not be empty'));
    const parsed: Column[] = [];
    for (const column of wire.columns) {
      const key = column.key;
      if (key === undefined || !(COLUMNS as readonly string[]).includes(key)) {
        return err(invalid(`columns[].key ${String(key)} is not a settlement report column`));
      }
      parsed.push({ key: key as ColumnKey, alias: column.alias ?? null });
    }
    columns = parsed;
  }

  const emails = wire.notification_email_list ?? base.notification_email_list;
  const scheduled = typeof wire.scheduled === 'boolean' ? wire.scheduled : base.scheduled;

  let frequency = base.frequency;
  if (body['frequency'] !== undefined) {
    const parsed = parseFrequency(body['frequency']);
    if (!parsed.ok) return parsed;
    frequency = parsed.value;
  }

  return ok({
    file_name_prefix: prefix,
    column_separator: separator,
    display_timezone: zone,
    columns,
    notification_email_list: [...emails],
    sftp_info: (body['sftp_info'] ?? base.sftp_info) as JsonValue,
    scheduled,
    frequency,
  });
}

function parseFrequency(value: unknown): Result<Frequency, ErrorBody> {
  if (!isJsonObject(value)) return err(invalid('frequency must be an object'));
  const type = value['type'] ?? 'daily';
  if (type !== 'daily' && type !== 'weekly' && type !== 'monthly') {
    return err(invalid('frequency.type must be daily, weekly or monthly'));
  }
  const hour = value['hour'] ?? 0;
  if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    return err(invalid('frequency.hour must be an integer between 0 and 23'));
  }
  return ok({ type, hour });
}

function storeConfig(context: ServiceContext, config: ConfigDoc): StoredDocument {
  const now = context.clock.now();
  const existing = configDocument(context);
  if (existing === null) {
    const document: StoredDocument = {
      kind: 'report_config',
      id: CONFIG_ID,
      sequence: context.store.nextSequence('report_config'),
      status: 'active',
      externalReference: null,
      lookup: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: null,
      doc: asJson(config),
    };
    context.store.documents.insert(document);
    return document;
  }
  const updated: StoredDocument = { ...existing, updatedAt: now, doc: asJson(config) };
  context.store.documents.update(updated);
  return updated;
}

function renderConfig(config: ConfigDoc): ReportConfig {
  return compact<ReportConfig>({
    file_name_prefix: config.file_name_prefix,
    column_separator: config.column_separator,
    display_timezone: config.display_timezone,
    columns: config.columns.map((column) =>
      compact<{ key?: string; alias?: string }>({
        key: column.key,
        alias: column.alias ?? undefined,
      }),
    ),
    notification_email_list: config.notification_email_list,
    sftp_info: (config.sftp_info ?? undefined) as unknown as ReportConfig['sftp_info'],
    scheduled: config.scheduled,
    frequency: config.frequency ?? undefined,
  });
}

export function getSettlementReportConfig(context: ServiceContext): Result<Rendered, ErrorBody> {
  return ok({ status: 200, body: renderConfig(currentConfig(context)) });
}

export function createSettlementReportConfig(
  context: ServiceContext,
  body: unknown,
): Result<Rendered, ErrorBody> {
  // A create resets the rendering options, but the schedule belongs to /schedule.
  const current = currentConfig(context);
  const parsed = parseConfig(body, {
    ...DEFAULT_CONFIG,
    scheduled: current.scheduled,
    frequency: current.frequency,
  });
  if (!parsed.ok) return parsed;
  storeConfig(context, parsed.value);
  return ok({ status: 200, body: renderConfig(parsed.value) });
}

export function updateSettlementReportConfig(
  context: ServiceContext,
  body: unknown,
): Result<Rendered, ErrorBody> {
  const parsed = parseConfig(body, currentConfig(context));
  if (!parsed.ok) return parsed;
  storeConfig(context, parsed.value);
  return ok({ status: 200, body: renderConfig(parsed.value) });
}

/* ------------------------------------------------------------------ schedule */

export function enableSettlementReportSchedule(
  context: ServiceContext,
  body: unknown,
): Result<Rendered, ErrorBody> {
  const base = currentConfig(context);
  const raw = isJsonObject(body) ? body['frequency'] : undefined;
  let frequency: Frequency = base.frequency ?? { type: 'daily', hour: 0 };
  if (raw !== undefined) {
    const parsed = parseFrequency(raw);
    if (!parsed.ok) return parsed;
    frequency = parsed.value;
  }

  const config: ConfigDoc = { ...base, scheduled: true, frequency };
  storeConfig(context, config);
  return ok({ status: 200, body: renderConfig(config) });
}

export function disableSettlementReportSchedule(context: ServiceContext): Result<Rendered, ErrorBody> {
  const config: ConfigDoc = { ...currentConfig(context), scheduled: false };
  storeConfig(context, config);
  return ok({ status: 200, body: renderConfig(config) });
}

export function listScheduledSettlementReports(context: ServiceContext): Result<Rendered, ErrorBody> {
  const config = currentConfig(context);
  const results =
    config.scheduled && config.frequency !== null
      ? [
          {
            file_name_prefix: config.file_name_prefix,
            frequency: config.frequency,
            display_timezone: config.display_timezone,
            next_execution: formatInZone(
              nextExecution(config.frequency, config.display_timezone, context.clock.now()),
              config.display_timezone,
            ),
          },
        ]
      : [];

  return ok({
    status: 200,
    body: { paging: { total: results.length, limit: results.length, offset: 0 }, results },
  });
}

/* ------------------------------------------------------------------ rows */

function eachPayment(context: ServiceContext, until: number, visit: (payment: Payment) => void): void {
  for (let offset = 0; offset < ROW_CAP; offset += PAGE) {
    const page = context.store.payments.search({
      createdTo: until,
      limit: PAGE,
      offset,
      sort: 'date_created',
      order: 'asc',
    });
    for (const payment of page.results) visit(payment);
    if (page.results.length < PAGE || offset + PAGE >= page.total) return;
  }
}

/** Half-open, so two back-to-back reports never claim the same movement twice. */
const inRange = (at: number, begin: number, end: number): boolean => at >= begin && at < end;

/**
 * Every movement the sandbox actually recorded between `begin` and `end`. A payment only
 * settles money once it has a settlement date, so unpaid and rejected payments never appear.
 */
function collectRows(context: ServiceContext, begin: number, end: number): Row[] {
  const rows: Row[] = [];

  eachPayment(context, end, (payment) => {
    const sequence = context.store.payments.sequenceOf(payment.id);
    if (sequence === null) return;
    const { status, status_detail } = providerStatus(payment);
    const common = {
      source_id: sequence,
      external_reference: payment.externalReference,
      currency: payment.currency,
      payment_method_type: paymentTypeId(payment),
      payment_method: payment.method.code,
      installments: payment.installments,
      settlement_date: payment.settledAt,
      // The row reports the state of the payment it belongs to, so a reconciliation against
      // GET /v1/payments/{id} compares like with like.
      status,
      status_detail,
    };

    if (payment.settledAt !== null && payment.capturedAmount > 0 && inRange(payment.settledAt, begin, end)) {
      rows.push({
        ...common,
        date: payment.settledAt,
        transaction_type: 'SETTLEMENT',
        sign: 1,
        amount: payment.capturedAmount,
      });
    }

    if (payment.settledAt === null) return;

    for (const refund of context.store.refunds.listFor(payment.id)) {
      if (refund.status !== 'approved' || !inRange(refund.createdAt, begin, end)) continue;
      rows.push({
        ...common,
        date: refund.createdAt,
        transaction_type: 'REFUND',
        sign: -1,
        amount: refund.amount,
      });
    }

    // charged_back is terminal, so updatedAt is fixed at the moment the chargeback landed.
    const reversed = payment.capturedAmount - payment.refundedAmount;
    if (payment.status.state === 'charged_back' && reversed > 0 && inRange(payment.updatedAt, begin, end)) {
      rows.push({
        ...common,
        date: payment.updatedAt,
        transaction_type: 'CHARGEBACK',
        sign: -1,
        amount: reversed,
      });
    }
  });

  const order: Record<TransactionType, number> = { SETTLEMENT: 0, REFUND: 1, CHARGEBACK: 2 };
  rows.sort(
    (a, b) =>
      a.date - b.date ||
      a.source_id - b.source_id ||
      order[a.transaction_type] - order[b.transaction_type] ||
      a.amount - b.amount,
  );
  return rows.slice(0, ROW_CAP);
}

/* ------------------------------------------------------------------ csv */

function escape(value: string, separator: string): string {
  return value.includes(separator) || /["\r\n]/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

const money = (amount: number, sign: 1 | -1): string =>
  `${sign < 0 && amount !== 0 ? '-' : ''}${toDecimal(amount as Minor).toFixed(2)}`;

function cell(row: Row, key: ColumnKey, config: ConfigDoc): string {
  switch (key) {
    case 'DATE':
      return formatInZone(row.date, config.display_timezone);
    case 'SOURCE_ID':
      return String(row.source_id);
    case 'EXTERNAL_REFERENCE':
      return row.external_reference ?? '';
    case 'TRANSACTION_TYPE':
      return row.transaction_type;
    case 'TRANSACTION_AMOUNT':
      return money(row.amount, row.sign);
    case 'TRANSACTION_CURRENCY':
      return row.currency;
    // payground charges no fees, so the net is the gross; see FIDELITY.md.
    case 'SETTLEMENT_NET_AMOUNT':
      return money(row.amount, row.sign);
    case 'MP_FEE_AMOUNT':
    case 'FINANCING_FEE_AMOUNT':
    case 'TAXES_AMOUNT':
      return '0.00';
    case 'PAYMENT_METHOD_TYPE':
      return row.payment_method_type;
    case 'PAYMENT_METHOD':
      return row.payment_method;
    case 'INSTALLMENTS':
      return String(row.installments);
    case 'SETTLEMENT_DATE':
      return row.settlement_date === null ? '' : formatInZone(row.settlement_date, config.display_timezone);
    case 'STATUS':
      return row.status;
    case 'STATUS_DETAIL':
      return row.status_detail;
  }
}

export function renderCsv(rows: readonly Row[], config: ConfigDoc): string {
  const separator = config.column_separator;
  const lines = [
    config.columns.map((column) => escape(column.alias ?? column.key, separator)).join(separator),
  ];
  for (const row of rows) {
    lines.push(config.columns.map((column) => escape(cell(row, column.key, config), separator)).join(separator));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/* ------------------------------------------------------------------ tasks */

function stageAt(elapsed: number): TaskStatus {
  if (elapsed < QUEUED_MS) return 'pending';
  if (elapsed < QUEUED_MS + GENERATING_MS) return 'in_progress';
  return 'done';
}

function renderTask(context: ServiceContext, task: StoredDocument): ReportTask {
  const doc = readTask(task);
  const status = task.status as TaskStatus;
  const fileName = status === 'done' ? doc.file_name : null;

  return compact<ReportTask>({
    id: task.id,
    status,
    begin_date: formatDateTime(doc.begin),
    end_date: formatDateTime(doc.end),
    created_at: formatDateTime(task.createdAt),
    updated_at: formatDateTime(task.updatedAt),
    file_name: fileName,
    download_url:
      fileName === null ? null : `${context.baseUrl}/v1/account/settlement_report/${fileName}`,
  });
}

/** Materialises the file the task promised, from the payments and refunds in its window. */
function materialize(context: ServiceContext, task: StoredDocument): void {
  const doc = readTask(task);
  const report = context.store.documents.get('report', doc.report_id);
  if (report === null || report.status === 'available') return;

  const stored = readReport(report);
  context.store.documents.update({
    ...report,
    status: 'available',
    updatedAt: context.clock.now(),
    doc: asJson({ ...stored, content: renderCsv(collectRows(context, doc.begin, doc.end), stored.config) }),
  });
}

function advance(context: ServiceContext, task: StoredDocument): StoredDocument {
  if (task.status === 'done' || task.status === 'failed') return task;
  const stage = stageAt(context.clock.now() - task.createdAt);
  if (stage === task.status) return task;
  if (stage === 'done') materialize(context, task);

  const updated: StoredDocument = { ...task, status: stage, updatedAt: context.clock.now() };
  context.store.documents.update(updated);
  return updated;
}

/**
 * Drives every outstanding task to where the clock says it should be. Reads advance their own
 * task, so this only exists for callers that want to settle the whole queue at once. Finished
 * tasks are excluded from the query, which otherwise fills up with them and starves new ones.
 */
export function runSettlementReports(context: ServiceContext): { generated: number } {
  let generated = 0;
  for (const status of ['pending', 'in_progress'] as const) {
    const found = context.store.documents.search('report_task', { status, limit: PAGE, offset: 0, order: 'asc' });
    for (const task of found.results) {
      if (task.id.startsWith(PREFIX) && advance(context, task).status === 'done') generated += 1;
    }
  }
  return { generated };
}

export function createSettlementReport(context: ServiceContext, body: unknown): Result<Rendered, ErrorBody> {
  if (!isJsonObject(body)) return err(badRequest('the body must be a Json Object'));
  const validated = validateReportRequest(body);
  if (!validated.ok) return err(issues(validated.error));

  const begin = parseDate(validated.value.begin_date, 'begin_date');
  if (!begin.ok) return begin;
  const end = parseDate(validated.value.end_date, 'end_date');
  if (!end.ok) return end;
  if (begin.value > end.value) return err(invalid('begin_date must not be after end_date'));

  const config = currentConfig(context);
  const now = context.clock.now();
  const reportId = `${PREFIX}${resourceId(context.ids.uuid())}`;
  const taskId = `${PREFIX}task-${resourceId(context.ids.uuid())}`;
  // The whole report id goes into the name: it is the download key, so it has to be unique.
  const fileName = `${config.file_name_prefix}-${ymd(begin.value)}-${ymd(end.value)}-${reportId.slice(PREFIX.length)}.csv`;

  const report: StoredDocument = {
    kind: 'report',
    id: reportId,
    sequence: context.store.nextSequence('report'),
    status: 'pending',
    externalReference: null,
    lookup: fileName,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    // The config is snapshotted: the file is rendered as it was requested, not as it is read.
    doc: asJson({ task_id: taskId, config, content: '' }),
  };
  context.store.documents.insert(report);

  const task: StoredDocument = {
    kind: 'report_task',
    id: taskId,
    sequence: context.store.nextSequence('report_task'),
    status: 'pending',
    externalReference: null,
    lookup: reportId,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    doc: asJson({ report_id: reportId, begin: begin.value, end: end.value, file_name: fileName }),
  };
  context.store.documents.insert(task);

  return ok({ status: 202, body: renderTask(context, task) });
}

export function getSettlementReportTask(context: ServiceContext, id: string): Result<Rendered, ErrorBody> {
  const task = context.store.documents.get('report_task', id);
  if (task === null || !task.id.startsWith(PREFIX)) return err(notFound('Report task not found'));
  return ok({ status: 200, body: renderTask(context, advance(context, task)) });
}

/* ------------------------------------------------------------------ files */

/** Listing reads the task documents: the report document carries the file and is never listed. */
function renderEntry(task: StoredDocument): ReportEntry {
  const doc = readTask(task);
  return compact<ReportEntry>({
    id: doc.report_id,
    status: 'available',
    date_created: formatDateTime(task.createdAt),
    date_last_updated: formatDateTime(task.updatedAt),
    begin_date: formatDateTime(doc.begin),
    end_date: formatDateTime(doc.end),
    file_name: doc.file_name,
  });
}

interface Paging {
  limit: number;
  offset: number;
}

function paging(params: URLSearchParams): Paging {
  const limit = Number(params.get('limit') ?? 30);
  const offset = Number(params.get('offset') ?? 0);
  return {
    limit: Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), PAGE) : 30,
    offset: Number.isFinite(offset) ? Math.max(Math.trunc(offset), 0) : 0,
  };
}

function finishedTasks(context: ServiceContext): StoredDocument[] {
  runSettlementReports(context);
  const found = context.store.documents.search('report_task', {
    status: 'done',
    limit: PAGE,
    offset: 0,
    order: 'desc',
  });
  return found.results.filter((task) => task.id.startsWith(PREFIX));
}

const listing = (tasks: readonly StoredDocument[], page: Paging): Rendered => ({
  status: 200,
  body: {
    paging: { total: tasks.length, limit: page.limit, offset: page.offset },
    results: tasks.slice(page.offset, page.offset + page.limit).map(renderEntry),
  },
});

export function getSettlementReport(context: ServiceContext, params: URLSearchParams): Result<Rendered, ErrorBody> {
  return ok(listing(finishedTasks(context), paging(params)));
}

export function searchSettlementReports(
  context: ServiceContext,
  params: URLSearchParams,
): Result<Rendered, ErrorBody> {
  let begin = Number.NEGATIVE_INFINITY;
  let end = Number.POSITIVE_INFINITY;

  const rawBegin = params.get('begin_date');
  if (rawBegin !== null) {
    const parsed = parseDate(rawBegin, 'begin_date');
    if (!parsed.ok) return parsed;
    begin = parsed.value;
  }
  const rawEnd = params.get('end_date');
  if (rawEnd !== null) {
    const parsed = parseDate(rawEnd, 'end_date');
    if (!parsed.ok) return parsed;
    end = parsed.value;
  }

  const matched = finishedTasks(context).filter((task) => {
    const doc = readTask(task);
    return doc.begin >= begin && doc.end <= end;
  });
  return ok(listing(matched, paging(params)));
}

export interface ReportFile {
  fileName: string;
  content: string;
}

export function downloadSettlementReport(
  context: ServiceContext,
  fileName: string,
): Result<ReportFile, ErrorBody> {
  runSettlementReports(context);
  const report = context.store.documents.byLookup('report', fileName);
  if (report === null || !report.id.startsWith(PREFIX)) return err(notFound('Report not found'));
  if (report.status !== 'available') return err(notFound('Report is still being generated'));
  return ok({ fileName, content: readReport(report).content });
}
