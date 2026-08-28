import { Database } from 'bun:sqlite';
import type { SandboxId, SandboxStore } from '@payground/core';
import { SqliteDocumentRepository } from './documents.ts';
import { SqliteIdempotencyStore } from './idempotency.ts';
import { MIGRATIONS } from './migrations.ts';
import { SqlitePaymentRepository } from './payments.ts';
import { SqliteRefundRepository } from './refunds.ts';
import { SqliteSandboxRegistry } from './registry.ts';
import { SqliteDeliveryQueue, SqliteFaultStore, SqliteWebhookRepository } from './webhooks.ts';

export interface StorageOptions {
  /** File path, or `:memory:` (the default). */
  path?: string;
}

export class Storage {
  readonly sandboxes: SqliteSandboxRegistry;
  readonly queue: SqliteDeliveryQueue;

  private constructor(private readonly db: Database) {
    this.sandboxes = new SqliteSandboxRegistry(db);
    this.queue = new SqliteDeliveryQueue(db);
  }

  static open(options: StorageOptions = {}): Storage {
    const path = options.path ?? ':memory:';
    const db = new Database(path, { create: true, strict: false });
    db.exec('pragma foreign_keys = on');
    if (path !== ':memory:') db.exec('pragma journal_mode = wal');
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
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .query('insert into schema_migrations (version, name, applied_at) values (?, ?, ?)')
          .run(migration.version, migration.name, Date.now());
      })();
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
