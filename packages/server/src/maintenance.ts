import { Database } from 'bun:sqlite';
import { type Clock, type Result, err, ok } from '@payground/core';
import { VERSION } from './health.ts';

/** Bumped whenever the shape below changes in a way an older build cannot read. */
export const EXPORT_SCHEMA = 1;

export type Row = Record<string, string | number | null>;

export interface TableSpec {
  readonly name: string;
  readonly columns: readonly string[];
}

export const SANDBOX_COLUMNS = [
  'id',
  'name',
  'access_token',
  'public_key',
  'webhook_secret',
  'live_mode',
  'created_at',
] as const;

/** Ordered so that a parent row always lands before the rows referencing it. */
export const EXPORTED_TABLES: readonly TableSpec[] = [
  { name: 'counters', columns: ['sandbox_id', 'scope', 'value'] },
  {
    name: 'payments',
    columns: [
      'sandbox_id', 'id', 'sequence', 'state', 'reason', 'method_kind', 'method_code', 'card',
      'payer_email', 'payer_first_name', 'payer_last_name', 'payer_document_type', 'payer_document_number',
      'amount', 'captured_amount', 'refunded_amount', 'currency', 'installments', 'binary_mode',
      'capture_on_create', 'description', 'external_reference', 'notification_url', 'metadata',
      'created_at', 'updated_at', 'settled_at', 'expires_at',
    ],
  },
  {
    name: 'payment_events',
    columns: ['sandbox_id', 'payment_id', 'seq', 'at', 'command', 'from_state', 'from_reason', 'to_state', 'to_reason'],
  },
  {
    name: 'refunds',
    columns: ['sandbox_id', 'id', 'sequence', 'payment_id', 'amount', 'status', 'partial', 'created_at'],
  },
  {
    name: 'documents',
    columns: [
      'sandbox_id', 'kind', 'id', 'sequence', 'status', 'external_reference', 'lookup',
      'created_at', 'updated_at', 'expires_at', 'doc',
    ],
  },
  {
    // The lease columns are deliberately absent: a restored delivery must not look leased.
    name: 'webhook_deliveries',
    columns: [
      'sandbox_id', 'id', 'sequence', 'event', 'resource_type', 'resource_id', 'url', 'status', 'attempts',
      'request_headers', 'request_body', 'last_status_code', 'last_error', 'response_body',
      'next_attempt_at', 'created_at', 'updated_at',
    ],
  },
  {
    name: 'webhook_attempts',
    columns: ['sandbox_id', 'delivery_id', 'seq', 'at', 'status_code', 'error', 'duration_ms'],
  },
  {
    name: 'fault_profiles',
    columns: ['sandbox_id', 'latency_ms', 'error_rate', 'unavailable', 'duplicate_webhooks', 'webhook_failure_rate'],
  },
];

/**
 * Opens an existing database for a CLI command. The schema must already exist, so no
 * migration runs, but the pragma order matters exactly as it does in `Storage.open`:
 * busy_timeout has to be set before the WAL switch, which needs a brief exclusive lock.
 */
export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true, strict: false });
  try {
    db.exec('pragma foreign_keys = on');
    if (path !== ':memory:') {
      db.exec('pragma busy_timeout = 5000');
      db.exec('pragma journal_mode = wal');
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export interface ExportOptions {
  readonly sandbox?: string;
  readonly now: number;
  readonly write: (chunk: string) => void;
}

export interface ExportSummary {
  readonly sandboxes: number;
  readonly rows: number;
}

/** The walk spans several tables, so it runs in one read transaction: a payment written
 *  between two queries would otherwise yield a refund whose parent is missing. */
export function exportSandboxes(db: Database, options: ExportOptions): Result<ExportSummary, string> {
  return db.transaction(() => walk(db, options))();
}

function walk(db: Database, options: ExportOptions): Result<ExportSummary, string> {
  const columns = SANDBOX_COLUMNS.join(', ');
  const sandboxes =
    options.sandbox === undefined
      ? db.query<Row, []>(`select ${columns} from sandboxes order by created_at, id`).all()
      : db.query<Row, [string]>(`select ${columns} from sandboxes where id = ?`).all(options.sandbox);
  if (options.sandbox !== undefined && sandboxes.length === 0) {
    return err(`sandbox not found: ${options.sandbox}`);
  }

  const write = options.write;
  write(
    `{"schema":${EXPORT_SCHEMA},"exportedAt":${options.now},"generator":${JSON.stringify(`payground ${VERSION}`)},"sandboxes":[`,
  );

  let rows = 0;
  sandboxes.forEach((sandbox, index) => {
    write(`${index === 0 ? '\n' : ',\n'}{"sandbox":${JSON.stringify(sandbox)},"tables":{`);
    EXPORTED_TABLES.forEach((table, position) => {
      write(`${position === 0 ? '\n' : ',\n'}${JSON.stringify(table.name)}:[`);
      const query = db.query<Row, [string]>(
        `select ${table.columns.join(', ')} from ${table.name} where sandbox_id = ? order by rowid`,
      );
      let written = 0;
      for (const row of query.iterate(String(sandbox['id']))) {
        write(written === 0 ? '\n' : ',\n');
        write(JSON.stringify(row));
        written += 1;
        rows += 1;
      }
      write(']');
    });
    write('}}');
  });
  write('\n]}\n');

  return ok({ sandboxes: sandboxes.length, rows });
}

export interface ImportOptions {
  readonly as?: string;
  readonly replace: boolean;
  readonly uuid: () => string;
}

export interface ImportSummary {
  readonly sandbox: string;
  readonly rows: number;
  /** True when the snapshot's token or public key was already taken by another sandbox. */
  readonly regeneratedCredentials: boolean;
}

interface Snapshot {
  readonly sandbox: Row;
  readonly tables: ReadonlyMap<string, readonly Row[]>;
}

function asObject(value: unknown, what: string): Result<Record<string, unknown>, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return err(`${what} is not an object`);
  return ok(value as Record<string, unknown>);
}

function asRow(value: unknown, what: string, columns: readonly string[]): Result<Row, string> {
  const object = asObject(value, what);
  if (!object.ok) return object;
  const row: Row = {};
  for (const column of columns) {
    const cell = object.value[column];
    if (cell === undefined) return err(`${what} is missing the column ${column}`);
    if (typeof cell !== 'string' && typeof cell !== 'number' && cell !== null) {
      return err(`${what} has a non-scalar value in the column ${column}`);
    }
    row[column] = cell;
  }
  for (const key of Object.keys(object.value)) {
    if (!columns.includes(key)) return err(`${what} has an unknown column ${key}`);
  }
  return ok(row);
}

function readSnapshots(document: unknown): Result<readonly Snapshot[], string> {
  const root = asObject(document, 'the export');
  if (!root.ok) return root;
  const schema = root.value['schema'];
  if (typeof schema !== 'number') return err('the export has no schema version; it is not a payground export');
  if (schema !== EXPORT_SCHEMA) {
    return err(`unsupported export schema version ${schema}; this build reads version ${EXPORT_SCHEMA}`);
  }
  const list = root.value['sandboxes'];
  if (!Array.isArray(list)) return err('the export has no sandboxes array');

  const snapshots: Snapshot[] = [];
  for (const [index, entry] of list.entries()) {
    const wrapper = asObject(entry, `sandboxes[${index}]`);
    if (!wrapper.ok) return wrapper;
    const sandbox = asRow(wrapper.value['sandbox'], `sandboxes[${index}].sandbox`, SANDBOX_COLUMNS);
    if (!sandbox.ok) return sandbox;
    const tables = asObject(wrapper.value['tables'] ?? {}, `sandboxes[${index}].tables`);
    if (!tables.ok) return tables;

    const known = new Set(EXPORTED_TABLES.map((table) => table.name));
    for (const key of Object.keys(tables.value)) {
      if (!known.has(key)) return err(`sandboxes[${index}].tables has an unknown table ${key}`);
    }

    const parsed = new Map<string, readonly Row[]>();
    for (const table of EXPORTED_TABLES) {
      const raw = tables.value[table.name] ?? [];
      if (!Array.isArray(raw)) return err(`sandboxes[${index}].tables.${table.name} is not an array`);
      const rows: Row[] = [];
      for (const [position, item] of raw.entries()) {
        const row = asRow(item, `sandboxes[${index}].tables.${table.name}[${position}]`, table.columns);
        if (!row.ok) return row;
        rows.push(row.value);
      }
      parsed.set(table.name, rows);
    }
    snapshots.push({ sandbox: sandbox.value, tables: parsed });
  }
  return ok(snapshots);
}

function insert(db: Database, table: string, columns: readonly string[], rows: readonly Row[]): void {
  if (rows.length === 0) return;
  const placeholders = columns.map((column) => `$${column}`);
  const statement = db.query(`insert into ${table} (${columns.join(', ')}) values (${placeholders.join(', ')})`);
  for (const row of rows) {
    const bindings: Row = {};
    for (const column of columns) bindings[`$${column}`] = row[column] ?? null;
    statement.run(bindings);
  }
}

class ImportRefused extends Error {}

export function importSnapshots(
  db: Database,
  document: unknown,
  options: ImportOptions,
): Result<readonly ImportSummary[], string> {
  const parsed = readSnapshots(document);
  if (!parsed.ok) return parsed;
  const snapshots = parsed.value;
  if (snapshots.length === 0) return err('the export holds no sandbox');
  if (options.as !== undefined && snapshots.length !== 1) {
    return err(`--as needs an export holding exactly one sandbox, this one holds ${snapshots.length}`);
  }

  const summaries: ImportSummary[] = [];
  try {
    db.transaction(() => {
      for (const snapshot of snapshots) {
        const source = String(snapshot.sandbox['id']);
        const target = options.as ?? source;

        const existing = db.query<{ id: string }, [string]>('select id from sandboxes where id = ?').get(target);
        if (existing !== null) {
          if (!options.replace) throw new ImportRefused(`sandbox ${target} already exists; pass --replace to overwrite it`);
          db.query('delete from sandboxes where id = ?').run(target);
        }

        const sandbox: Row = { ...snapshot.sandbox, id: target };
        const clash = db
          .query<{ id: string }, [string, string, string]>(
            'select id from sandboxes where (access_token = ? or public_key = ?) and id <> ?',
          )
          .get(String(sandbox['access_token']), String(sandbox['public_key']), target);
        const regenerated = clash !== null;
        if (regenerated) {
          sandbox['access_token'] = `TEST-${options.uuid()}`;
          sandbox['public_key'] = `TEST-${options.uuid()}`;
        }
        insert(db, 'sandboxes', SANDBOX_COLUMNS, [sandbox]);

        let rows = 0;
        for (const table of EXPORTED_TABLES) {
          const original = snapshot.tables.get(table.name) ?? [];
          const remapped = target === source ? original : original.map((row) => ({ ...row, sandbox_id: target }));
          insert(db, table.name, table.columns, remapped);
          rows += remapped.length;
        }
        summaries.push({ sandbox: target, rows, regeneratedCredentials: regenerated });
      }
    })();
  } catch (error) {
    // Anything thrown here rolled the transaction back, so the database is untouched.
    if (error instanceof ImportRefused) return err(error.message);
    return err(`cannot import the export: ${error instanceof Error ? error.message : String(error)}`);
  }

  return ok(summaries);
}

export function backup(db: Database): Uint8Array {
  return db.serialize();
}

export type PruneCategory = 'requests' | 'audit' | 'webhooks' | 'payments';

/** Child rows first, so a dry run counts exactly what a real run deletes. */
const PRUNE_RULES: Record<PruneCategory, readonly { readonly table: string; readonly where: string }[]> = {
  requests: [{ table: 'api_requests', where: 'at < ?' }],
  audit: [{ table: 'audit_log', where: 'at < ?' }],
  // Only settled deliveries: dropping one the runner is delivering would make it fail
  // to update a row that no longer exists.
  webhooks: [
    {
      table: 'webhook_attempts',
      where: `(sandbox_id, delivery_id) in (select sandbox_id, id from webhook_deliveries
        where created_at < ? and status in ('delivered', 'exhausted'))`,
    },
    { table: 'webhook_deliveries', where: `created_at < ? and status in ('delivered', 'exhausted')` },
  ],
  payments: [
    {
      table: 'payment_events',
      where: '(sandbox_id, payment_id) in (select sandbox_id, id from payments where created_at < ?)',
    },
    {
      table: 'refunds',
      where: '(sandbox_id, payment_id) in (select sandbox_id, id from payments where created_at < ?)',
    },
    { table: 'payments', where: 'created_at < ?' },
  ],
};

export const PRUNE_CATEGORIES: readonly PruneCategory[] = ['requests', 'audit', 'webhooks', 'payments'];

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneSpec {
  readonly now: number;
  readonly dryRun: boolean;
  /** Age in days per category. An absent category is left alone. */
  readonly days: Partial<Record<PruneCategory, number>>;
}

export interface PruneReport {
  readonly deleted: readonly { readonly table: string; readonly rows: number }[];
  readonly total: number;
}

export function prune(db: Database, spec: PruneSpec): PruneReport {
  const deleted: { table: string; rows: number }[] = [];
  db.transaction(() => {
    for (const category of PRUNE_CATEGORIES) {
      const days = spec.days[category];
      if (days === undefined) continue;
      const cutoff = spec.now - days * DAY_MS;
      for (const rule of PRUNE_RULES[category]) {
        const rows = spec.dryRun
          ? (db
              .query<{ n: number }, [number]>(`select count(*) as n from ${rule.table} where ${rule.where}`)
              .get(cutoff)?.n ?? 0)
          : db.query(`delete from ${rule.table} where ${rule.where}`).run(cutoff).changes;
        deleted.push({ table: rule.table, rows });
      }
    }
  })();
  return { deleted, total: deleted.reduce((sum, entry) => sum + entry.rows, 0) };
}

export interface RetentionOptions {
  readonly clock: Clock;
  readonly days: number;
  /** Defaults to one hour: retention is a background chore, not a hot path. */
  readonly intervalMs?: number;
  readonly onPrune?: (report: PruneReport) => void;
  readonly onError?: (message: string) => void;
}

export interface Retention {
  /** Null when the prune failed; the failure went to `onError`. */
  runNow(): PruneReport | null;
  stop(): void;
}

const HOUR_MS = 60 * 60 * 1000;

export function startRetention(db: Database, options: RetentionOptions): Retention {
  const days = Object.fromEntries(PRUNE_CATEGORIES.map((category) => [category, options.days]));
  // Thrown from a timer this would be an uncaught exception, which would stop the server.
  const runNow = (): PruneReport | null => {
    try {
      const report = prune(db, { now: options.clock.now(), dryRun: false, days });
      options.onPrune?.(report);
      return report;
    } catch (error) {
      options.onError?.(error instanceof Error ? error.message : String(error));
      return null;
    }
  };
  const timer = setInterval(() => void runNow(), Math.max(options.intervalMs ?? HOUR_MS, 1));
  timer.unref();
  return { runNow, stop: () => clearInterval(timer) };
}
