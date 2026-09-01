import type { Database } from 'bun:sqlite';
import {
  type ApiRequestEntry,
  type ApiRequestLog,
  type ApiRequestQuery,
  type Page,
  sandboxId,
} from '@payground/core';

interface Row {
  id: string;
  at: number;
  sandbox_id: string | null;
  method: string;
  route: string;
  path: string;
  status: number;
  duration_ms: number;
  request_body: string | null;
  response_body: string | null;
  idempotency_key: string | null;
  user_agent: string | null;
}

const COLUMNS =
  'id, at, sandbox_id, method, route, path, status, duration_ms, request_body, response_body, idempotency_key, user_agent';

const toEntry = (row: Row): ApiRequestEntry => ({
  id: row.id,
  at: row.at,
  sandbox: row.sandbox_id === null ? null : sandboxId(row.sandbox_id),
  method: row.method,
  route: row.route,
  path: row.path,
  status: row.status,
  durationMs: row.duration_ms,
  requestBody: row.request_body,
  responseBody: row.response_body,
  idempotencyKey: row.idempotency_key,
  userAgent: row.user_agent,
});

export class SqliteApiRequestLog implements ApiRequestLog {
  constructor(private readonly db: Database) {}

  record(entry: ApiRequestEntry): void {
    this.db
      .query(`insert into api_requests (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        entry.id,
        entry.at,
        entry.sandbox,
        entry.method,
        entry.route,
        entry.path,
        entry.status,
        entry.durationMs,
        entry.requestBody,
        entry.responseBody,
        entry.idempotencyKey,
        entry.userAgent,
      );
  }

  get(id: string): ApiRequestEntry | null {
    const row = this.db
      .query<Row, [string]>(`select ${COLUMNS} from api_requests where id = ?`)
      .get(id);
    return row === null ? null : toEntry(row);
  }

  search(query: ApiRequestQuery): Page<ApiRequestEntry> {
    const where: string[] = ['1 = 1'];
    const params: Record<string, string | number> = {};

    if (query.sandbox !== undefined) {
      where.push('sandbox_id = $sandbox');
      params['$sandbox'] = query.sandbox;
    }
    if (query.route !== undefined) {
      where.push('route = $route');
      params['$route'] = query.route;
    }
    if (query.method !== undefined) {
      where.push('method = $method');
      params['$method'] = query.method;
    }
    if (query.status !== undefined) {
      where.push('status = $status');
      params['$status'] = query.status;
    }
    if (query.minStatus !== undefined) {
      where.push('status >= $min_status');
      params['$min_status'] = query.minStatus;
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
      .query<{ n: number }, typeof params>(`select count(*) as n from api_requests where ${clause}`)
      .get(params);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 1000);
    const offset = Math.max(query.offset ?? 0, 0);

    const rows = this.db
      .query<Row, Record<string, string | number>>(
        `select ${COLUMNS} from api_requests where ${clause} order by at desc, id desc limit $limit offset $offset`,
      )
      .all({ ...params, $limit: limit, $offset: offset });

    return { total: total?.n ?? 0, limit, offset, results: rows.map(toEntry) };
  }

  purgeBefore(cutoff: number): number {
    return this.db.query('delete from api_requests where at < ?').run(cutoff).changes;
  }
}
