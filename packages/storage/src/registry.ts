import type { Database } from 'bun:sqlite';
import { type Sandbox, type SandboxId, type SandboxRegistry, sandboxId } from '@payground/core';

interface Row {
  id: string;
  name: string;
  access_token: string;
  public_key: string;
  webhook_secret: string;
  live_mode: number;
  created_at: number;
}

const toSandbox = (row: Row): Sandbox => ({
  id: sandboxId(row.id),
  name: row.name,
  accessToken: row.access_token,
  publicKey: row.public_key,
  webhookSecret: row.webhook_secret,
  liveMode: row.live_mode === 1,
  createdAt: row.created_at,
});

const SELECT = 'select id, name, access_token, public_key, webhook_secret, live_mode, created_at from sandboxes';

export class SqliteSandboxRegistry implements SandboxRegistry {
  constructor(private readonly db: Database) {}

  create(sandbox: Sandbox): void {
    this.db
      .query(
        `insert into sandboxes (id, name, access_token, public_key, webhook_secret, live_mode, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sandbox.id,
        sandbox.name,
        sandbox.accessToken,
        sandbox.publicKey,
        sandbox.webhookSecret,
        sandbox.liveMode ? 1 : 0,
        sandbox.createdAt,
      );
  }

  get(id: SandboxId): Sandbox | null {
    const row = this.db.query<Row, [string]>(`${SELECT} where id = ?`).get(id);
    return row === null ? null : toSandbox(row);
  }

  byAccessToken(token: string): Sandbox | null {
    const row = this.db.query<Row, [string]>(`${SELECT} where access_token = ?`).get(token);
    return row === null ? null : toSandbox(row);
  }

  byPublicKey(key: string): Sandbox | null {
    const row = this.db.query<Row, [string]>(`${SELECT} where public_key = ?`).get(key);
    return row === null ? null : toSandbox(row);
  }

  list(): readonly Sandbox[] {
    return this.db.query<Row, []>(`${SELECT} order by created_at`).all().map(toSandbox);
  }

  rename(id: SandboxId, name: string): boolean {
    return this.db.query('update sandboxes set name = ? where id = ?').run(name, id).changes > 0;
  }

  /** Drops the sandbox's data but keeps its credentials, so tests can start over. */
  reset(id: SandboxId): void {
    this.db.transaction(() => {
      for (const table of ['webhook_attempts', 'webhook_deliveries', 'payment_events', 'refunds', 'payments', 'documents', 'idempotency', 'counters']) {
        this.db.query(`delete from ${table} where sandbox_id = ?`).run(id);
      }
    })();
  }

  remove(id: SandboxId): void {
    this.db.query('delete from sandboxes where id = ?').run(id);
  }
}
