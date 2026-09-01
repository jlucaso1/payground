import type { Database } from 'bun:sqlite';
import {
  type AuditActor,
  type AuditEntry,
  type AuditLog,
  type AuditQuery,
  type JsonObject,
  type Page,
  isJsonObject,
  sandboxId,
} from '@payground/core';

interface Row {
  id: string;
  at: number;
  actor_kind: string;
  actor_sandbox: string | null;
  action: string;
  target: string;
  sandbox_id: string | null;
  detail: string;
}

function toActor(kind: string, sandbox: string | null): AuditActor {
  if (kind === 'admin') return { kind: 'admin' };
  if (kind === 'sandbox' && sandbox !== null) return { kind: 'sandbox', sandbox: sandboxId(sandbox) };
  return { kind: 'system' };
}

function toDetail(raw: string): JsonObject {
  const parsed: unknown = JSON.parse(raw);
  return isJsonObject(parsed) ? parsed : {};
}

const toEntry = (row: Row): AuditEntry => ({
  id: row.id,
  at: row.at,
  actor: toActor(row.actor_kind, row.actor_sandbox),
  action: row.action,
  target: row.target,
  sandbox: row.sandbox_id === null ? null : sandboxId(row.sandbox_id),
  detail: toDetail(row.detail),
});

const COLUMNS = 'id, at, actor_kind, actor_sandbox, action, target, sandbox_id, detail';

export class SqliteAuditLog implements AuditLog {
  constructor(private readonly db: Database) {}

  record(entry: AuditEntry): void {
    this.db
      .query(`insert into audit_log (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        entry.id,
        entry.at,
        entry.actor.kind,
        entry.actor.kind === 'sandbox' ? entry.actor.sandbox : null,
        entry.action,
        entry.target,
        entry.sandbox,
        JSON.stringify(entry.detail),
      );
  }

  search(query: AuditQuery): Page<AuditEntry> {
    const where: string[] = ['1 = 1'];
    const params: Record<string, string | number> = {};

    if (query.sandbox !== undefined) {
      where.push('sandbox_id = $sandbox');
      params['$sandbox'] = query.sandbox;
    }
    if (query.action !== undefined) {
      where.push('action = $action');
      params['$action'] = query.action;
    }
    if (query.from !== undefined) {
      where.push('at >= $from');
      params['$from'] = query.from;
    }
    if (query.to !== undefined) {
      where.push('at <= $to');
      params['$to'] = query.to;
    }

    const clause = where.join(' and ');
    const total = this.db
      .query<{ n: number }, typeof params>(`select count(*) as n from audit_log where ${clause}`)
      .get(params);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 1000);
    const offset = Math.max(query.offset ?? 0, 0);

    const rows = this.db
      .query<Row, Record<string, string | number>>(
        `select ${COLUMNS} from audit_log where ${clause} order by at desc, id desc limit $limit offset $offset`,
      )
      .all({ ...params, $limit: limit, $offset: offset });

    return { total: total?.n ?? 0, limit, offset, results: rows.map(toEntry) };
  }

  purgeBefore(cutoff: number): number {
    return this.db.query('delete from audit_log where at < ?').run(cutoff).changes;
  }
}
