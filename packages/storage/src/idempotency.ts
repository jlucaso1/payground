import type { Database } from 'bun:sqlite';
import type { IdempotencyRecord, IdempotencyStore, SandboxId } from '@payground/core';

interface Row {
  key: string;
  fingerprint: string;
  status: number;
  body: string;
  created_at: number;
}

export class SqliteIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly db: Database,
    private readonly sandbox: SandboxId,
  ) {}

  get(key: string): IdempotencyRecord | null {
    const row = this.db
      .query<Row, [string, string]>(
        'select key, fingerprint, status, body, created_at from idempotency where sandbox_id = ? and key = ?',
      )
      .get(this.sandbox, key);
    return row === null
      ? null
      : {
          key: row.key,
          fingerprint: row.fingerprint,
          status: row.status,
          body: row.body,
          createdAt: row.created_at,
        };
  }

  put(record: IdempotencyRecord): void {
    this.db
      .query(
        `insert into idempotency (sandbox_id, key, fingerprint, status, body, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(this.sandbox, record.key, record.fingerprint, record.status, record.body, record.createdAt);
  }

  purgeBefore(cutoff: number): number {
    return this.db
      .query('delete from idempotency where sandbox_id = ? and created_at < ?')
      .run(this.sandbox, cutoff).changes;
  }
}
