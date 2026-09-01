import { Database } from 'bun:sqlite';
import type { SandboxId, SandboxStore } from '@payground/core';
import { SqliteAuditLog } from './audit.ts';
import { SqliteDocumentRepository } from './documents.ts';
import { SqliteIdempotencyStore } from './idempotency.ts';
import { MIGRATIONS } from './migrations.ts';
import { SqlitePaymentRepository } from './payments.ts';
import { SqliteRefundRepository } from './refunds.ts';
import { SqliteSandboxRegistry } from './registry.ts';
import { SqliteApiRequestLog } from './requests.ts';
import { SqliteDeliveryQueue, SqliteFaultStore, SqliteWebhookRepository } from './webhooks.ts';

export interface StorageOptions {
  /** File path, or `:memory:` (the default). */
  path?: string;
  /** How long a writer waits for the lock before failing. Only meaningful on a file. */
  busyTimeoutMs?: number;
}

export class Storage {
  readonly sandboxes: SqliteSandboxRegistry;
  readonly queue: SqliteDeliveryQueue;
  readonly audit: SqliteAuditLog;
  readonly requests: SqliteApiRequestLog;

  private constructor(private readonly db: Database) {
    this.sandboxes = new SqliteSandboxRegistry(db);
    this.queue = new SqliteDeliveryQueue(db);
    this.audit = new SqliteAuditLog(db);
    this.requests = new SqliteApiRequestLog(db);
  }

  static open(options: StorageOptions = {}): Storage {
    const path = options.path ?? ':memory:';
    if (path === ':memory:') return Storage.connect(path, options);

    // Switching a fresh file to WAL takes a brief exclusive lock that busy_timeout does not
    // cover, so two processes starting at the same moment can collide. Retry the open,
    // bounded on wall clock: a failed attempt can itself block for the whole busy timeout.
    const deadline = Bun.nanoseconds() + Math.max(options.busyTimeoutMs ?? 5_000, 0) * 1e6;
    for (;;) {
      try {
        return Storage.connect(path, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/locked|busy/i.test(message) || Bun.nanoseconds() >= deadline) throw error;
        Bun.sleepSync(25);
      }
    }
  }

  private static connect(path: string, options: StorageOptions): Storage {
    const db = new Database(path, { create: true, strict: false });
    try {
      return Storage.prepare(db, path, options);
    } catch (error) {
      // Otherwise every retry leaks a handle and a file descriptor.
      db.close();
      throw error;
    }
  }

  private static prepare(db: Database, path: string, options: StorageOptions): Storage {
    db.exec('pragma foreign_keys = on');
    if (path !== ':memory:') {
      // busy_timeout first: switching to WAL needs a brief exclusive lock, and two
      // processes opening a fresh file at the same moment would otherwise race and one
      // would fail outright with SQLITE_BUSY instead of waiting.
      db.exec(`pragma busy_timeout = ${Math.max(options.busyTimeoutMs ?? 5_000, 0)}`);
      // journal_mode answers with the mode it settled on rather than failing, so a
      // contended switch silently leaves the connection on the rollback journal.
      const mode = db
        .query<{ journal_mode: string }, []>('pragma journal_mode = wal')
        .get()?.journal_mode;
      if (mode !== 'wal') throw new Error(`database is locked: journal_mode stayed ${mode ?? 'unknown'}`);
      db.exec('pragma synchronous = normal');
    }
    const storage = new Storage(db);
    storage.migrate();
    return storage;
  }

  migrate(): void {
    this.db.exec('create table if not exists schema_migrations (version integer primary key, name text not null, applied_at integer not null) strict');
    const applied = new Set(
      this.db.query<{ version: number }, []>('select version from schema_migrations').all().map((r) => r.version),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      // Immediate takes the write lock up front, so two processes cannot both migrate.
      this.db.transaction(() => {
        const done = this.db
          .query<{ version: number }, [number]>('select version from schema_migrations where version = ?')
          .get(migration.version);
        if (done !== null) return;
        this.db.exec(migration.sql);
        this.db
          .query('insert into schema_migrations (version, name, applied_at) values (?, ?, ?)')
          .run(migration.version, migration.name, Date.now());
      }).immediate();
    }
  }

  /** The only way to reach data. A repository cannot express a cross-sandbox query. */
  forSandbox(id: SandboxId): SandboxStore {
    const db = this.db;
    return {
      id,
      payments: new SqlitePaymentRepository(db, id),
      refunds: new SqliteRefundRepository(db, id),
      idempotency: new SqliteIdempotencyStore(db, id),
      documents: new SqliteDocumentRepository(db, id),
      webhooks: new SqliteWebhookRepository(db, id),
      faults: new SqliteFaultStore(db, id),
      nextSequence(scope: string): number {
        const row = db
          .query<{ value: number }, [string, string]>(
            `insert into counters (sandbox_id, scope, value) values (?, ?, 1)
             on conflict (sandbox_id, scope) do update set value = value + 1
             returning value`,
          )
          .get(id, scope);
        if (row === null) throw new Error(`counter failed for scope ${scope}`);
        return row.value;
      },
    };
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}

export { MIGRATIONS } from './migrations.ts';
export { SqliteAuditLog } from './audit.ts';
export { SqliteApiRequestLog } from './requests.ts';
