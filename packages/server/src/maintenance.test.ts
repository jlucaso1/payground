import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '@payground/core/testing.ts';
import { MIGRATIONS } from '@payground/storage';
import {
  EXPORT_SCHEMA,
  EXPORTED_TABLES,
  SANDBOX_COLUMNS,
  exportSandboxes,
  importSnapshots,
  prune,
  startRetention,
} from './maintenance.ts';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const root = mkdtempSync(join(tmpdir(), 'payground-maintenance-module-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PAYMENT_COLUMNS = EXPORTED_TABLES.find((table) => table.name === 'payments')?.columns ?? [];

function payment(db: Database, id: string): void {
  db.query(
    `insert into payments (${PAYMENT_COLUMNS.join(', ')}) values (${PAYMENT_COLUMNS.map(() => '?').join(', ')})`,
  ).run(
    'sbx', id, id === 'p1' ? 1 : 2, 'pending', 'awaiting_payer', 'bank_transfer', 'pix', null,
    'a@example.com', null, null, null, null, 100, 0, 0, 'BRL', 1, 0, 1, null, null, null, '{}',
    NOW, NOW, null, null,
  );
}

function database(): Database {
  const db = new Database(':memory:', { strict: false });
  db.exec('pragma foreign_keys = on');
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  db.query('insert into sandboxes values (?, ?, ?, ?, ?, ?, ?)').run('sbx', 'default', 'TEST-a', 'TEST-b', 'secret', 0, NOW);
  return db;
}

function exported(db: Database): unknown {
  let text = '';
  const result = exportSandboxes(db, { now: NOW, write: (chunk) => (text += chunk) });
  expect(result.ok).toBe(true);
  return JSON.parse(text);
}

describe('export', () => {
  test('is valid JSON for an empty sandbox', () => {
    const db = database();
    expect(exported(db)).toMatchObject({ schema: EXPORT_SCHEMA, exportedAt: NOW });
    db.close();
  });

  test('every exported column exists in the schema, and no other column is missed', () => {
    const db = database();
    // The lease columns are excluded on purpose; anything else is drift.
    const skipped = new Set(['leased_until', 'leased_by']);
    for (const table of [...EXPORTED_TABLES, { name: 'sandboxes', columns: SANDBOX_COLUMNS }]) {
      const actual = db
        .query<{ name: string }, []>(`pragma table_info(${table.name})`)
        .all()
        .map((row) => row.name)
        .filter((name) => !skipped.has(name));
      expect(actual).toEqual([...table.columns]);
    }
    db.close();
  });

  test('a concurrent writer cannot slip a refund in without its payment', () => {
    const path = join(root, 'concurrent.sqlite');
    const db = new Database(path, { create: true, strict: false });
    db.exec('pragma journal_mode = wal');
    db.exec('pragma foreign_keys = on');
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    db.query('insert into sandboxes values (?, ?, ?, ?, ?, ?, ?)').run('sbx', 'default', 'TEST-a', 'TEST-b', 's', 0, NOW);
    payment(db, 'p1');

    const writer = new Database(path, { strict: false });
    writer.exec('pragma foreign_keys = on');
    let text = '';
    let injected = false;
    exportSandboxes(db, {
      now: NOW,
      write: (chunk) => {
        text += chunk;
        if (injected) return;
        injected = true;
        // Between the payments read and the refunds read, as a second process would.
        payment(writer, 'p2');
        writer
          .query('insert into refunds values (?, ?, ?, ?, ?, ?, ?, ?)')
          .run('sbx', 'r2', 1, 'p2', 100, 'approved', 0, NOW);
      },
    });
    writer.close();
    db.close();

    const document = JSON.parse(text) as { sandboxes: { tables: Record<string, { id?: string }[]> }[] };
    const tables = document.sandboxes[0]?.tables;
    expect(tables?.['payments']?.map((row) => row.id)).toEqual(['p1']);
    expect(tables?.['refunds']).toEqual([]);
  });
});

describe('import', () => {
  const uuid = (): string => 'fixed';

  test('rejects a row holding a column the schema does not know', () => {
    const db = database();
    const document = exported(db) as { sandboxes: { tables: Record<string, unknown[]> }[] };
    document.sandboxes[0]?.tables['counters']?.push({ sandbox_id: 'sbx', scope: 'payment', value: 1, extra: 2 });
    const result = importSnapshots(db, document, { replace: true, uuid });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('unknown column extra');
    db.close();
  });

  test('rejects a row holding a non-scalar value', () => {
    const db = database();
    const document = exported(db) as { sandboxes: { tables: Record<string, unknown[]> }[] };
    document.sandboxes[0]?.tables['counters']?.push({ sandbox_id: 'sbx', scope: 'payment', value: { a: 1 } });
    const result = importSnapshots(db, document, { replace: true, uuid });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('non-scalar');
    db.close();
  });

  test('rejects --as when the export holds more than one sandbox', () => {
    const db = database();
    db.query('insert into sandboxes values (?, ?, ?, ?, ?, ?, ?)').run('other', 'other', 'TEST-c', 'TEST-d', 's', 0, NOW);
    const result = importSnapshots(db, exported(db), { replace: true, as: 'one', uuid });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('exactly one sandbox');
    db.close();
  });

  test('leaves the database untouched when one sandbox of many is refused', () => {
    const source = database();
    source.query('insert into sandboxes values (?, ?, ?, ?, ?, ?, ?)').run('other', 'other', 'TEST-c', 'TEST-d', 's', 0, NOW);
    const document = exported(source);
    source.close();

    const target = database();
    // 'sbx' already exists there, so the whole import must roll back including 'other'.
    const result = importSnapshots(target, document, { replace: false, uuid });
    expect(result.ok).toBe(false);
    expect(target.query<{ n: number }, []>('select count(*) as n from sandboxes').get()?.n).toBe(1);
    target.close();
  });
});

describe('prune', () => {
  function withRequests(db: Database): void {
    for (let index = 0; index < 5; index += 1) {
      db.query(
        'insert into api_requests (id, at, sandbox_id, method, route, path, status, duration_ms) values (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(`r${index}`, NOW - index * DAY, 'sbx', 'GET', '/v1/payments', '/v1/payments', 200, 1);
    }
  }

  test('a dry run counts exactly what a real run deletes', () => {
    const db = database();
    withRequests(db);
    const dry = prune(db, { now: NOW, dryRun: true, days: { requests: 2 } });
    const real = prune(db, { now: NOW, dryRun: false, days: { requests: 2 } });
    expect(dry).toEqual(real);
    expect(real.total).toBe(2);
    db.close();
  });

  test('an untouched category is not reported', () => {
    const db = database();
    withRequests(db);
    const report = prune(db, { now: NOW, dryRun: true, days: { audit: 1 } });
    expect(report.deleted.map((entry) => entry.table)).toEqual(['audit_log']);
    db.close();
  });
});

describe('retention', () => {
  test('runs on demand against the injected clock and stops cleanly', () => {
    const db = database();
    db.query(
      'insert into api_requests (id, at, sandbox_id, method, route, path, status, duration_ms) values (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('r', NOW - 10 * DAY, 'sbx', 'GET', '/v1/payments', '/v1/payments', 200, 1);

    const clock = new ManualClock(NOW - 20 * DAY);
    const reports: number[] = [];
    const retention = startRetention(db, { clock, days: 7, onPrune: (report) => reports.push(report.total) });

    retention.runNow();
    clock.advance(40 * DAY);
    retention.runNow();
    retention.stop();

    expect(reports).toEqual([0, 1]);
    db.close();
  });

  test('reports a failing prune instead of throwing out of the timer', () => {
    const db = database();
    const failures: string[] = [];
    const retention = startRetention(db, {
      clock: new ManualClock(NOW),
      days: 1,
      onError: (reason) => failures.push(reason),
    });
    db.close();

    expect(retention.runNow()).toBeNull();
    expect(failures).toHaveLength(1);
    retention.stop();
  });
});
