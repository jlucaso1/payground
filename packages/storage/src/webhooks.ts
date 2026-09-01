import type { Database } from 'bun:sqlite';
import {
  type DeliveryQueue,
  type DeliveryStatus,
  type FaultProfile,
  type FaultStore,
  NO_FAULTS,
  type SandboxId,
  type WebhookAttempt,
  type WebhookDelivery,
  type WebhookDeliveryId,
  type WebhookRepository,
  sandboxId,
  webhookDeliveryId,
} from '@payground/core';

interface Row {
  sandbox_id: string;
  id: string;
  sequence: number;
  event: string;
  resource_type: string;
  resource_id: string;
  url: string;
  status: string;
  attempts: number;
  request_headers: string;
  request_body: string;
  last_status_code: number | null;
  last_error: string | null;
  response_body: string | null;
  next_attempt_at: number | null;
  created_at: number;
  updated_at: number;
}

const COLUMNS = `sandbox_id, id, sequence, event, resource_type, resource_id, url, status, attempts,
  request_headers, request_body, last_status_code, last_error, response_body, next_attempt_at,
  created_at, updated_at`;

const STATUSES: readonly string[] = ['queued', 'sending', 'delivered', 'retrying', 'exhausted'];

function toDelivery(row: Row): WebhookDelivery {
  if (!STATUSES.includes(row.status)) throw new Error(`corrupt delivery status: ${row.status}`);
  return {
    id: webhookDeliveryId(row.id),
    sandbox: sandboxId(row.sandbox_id),
    sequence: row.sequence,
    event: row.event,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    url: row.url,
    status: row.status as DeliveryStatus,
    attempts: row.attempts,
    requestHeaders: JSON.parse(row.request_headers) as Record<string, string>,
    requestBody: row.request_body,
    lastStatusCode: row.last_status_code,
    lastError: row.last_error,
    responseBody: row.response_body,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const bind = (delivery: WebhookDelivery): Record<string, string | number | null> => ({
  $sandbox_id: delivery.sandbox,
  $id: delivery.id,
  $sequence: delivery.sequence,
  $event: delivery.event,
  $resource_type: delivery.resourceType,
  $resource_id: delivery.resourceId,
  $url: delivery.url,
  $status: delivery.status,
  $attempts: delivery.attempts,
  $request_headers: JSON.stringify(delivery.requestHeaders),
  $request_body: delivery.requestBody,
  $last_status_code: delivery.lastStatusCode,
  $last_error: delivery.lastError,
  $response_body: delivery.responseBody,
  $next_attempt_at: delivery.nextAttemptAt,
  $created_at: delivery.createdAt,
  $updated_at: delivery.updatedAt,
});

export class SqliteWebhookRepository implements WebhookRepository {
  constructor(
    private readonly db: Database,
    private readonly sandbox: SandboxId,
  ) {}

  insert(delivery: WebhookDelivery): void {
    this.db
      .query(
        `insert into webhook_deliveries (${COLUMNS}) values (
          $sandbox_id, $id, $sequence, $event, $resource_type, $resource_id, $url, $status, $attempts,
          $request_headers, $request_body, $last_status_code, $last_error, $response_body,
          $next_attempt_at, $created_at, $updated_at)`,
      )
      .run(bind(delivery));
  }

  update(delivery: WebhookDelivery): void {
    const result = this.db
      .query(
        `update webhook_deliveries set status = $status, attempts = $attempts,
           last_status_code = $last_status_code, last_error = $last_error,
           response_body = $response_body, next_attempt_at = $next_attempt_at, updated_at = $updated_at
         where sandbox_id = $sandbox_id and id = $id`,
      )
      .run(bind(delivery));
    if (result.changes === 0) throw new Error(`delivery not found: ${delivery.id}`);
  }

  get(id: WebhookDeliveryId): WebhookDelivery | null {
    const row = this.db
      .query<Row, [string, string]>(`select ${COLUMNS} from webhook_deliveries where sandbox_id = ? and id = ?`)
      .get(this.sandbox, id);
    return row === null ? null : toDelivery(row);
  }

  list(limit = 100): readonly WebhookDelivery[] {
    return this.db
      .query<Row, [string, number]>(
        `select ${COLUMNS} from webhook_deliveries where sandbox_id = ? order by created_at desc, sequence desc limit ?`,
      )
      .all(this.sandbox, Math.min(Math.max(limit, 1), 1000))
      .map(toDelivery);
  }

  attempts(id: WebhookDeliveryId): readonly WebhookAttempt[] {
    return this.db
      .query<{ seq: number; at: number; status_code: number | null; error: string | null; duration_ms: number }, [string, string]>(
        'select seq, at, status_code, error, duration_ms from webhook_attempts where sandbox_id = ? and delivery_id = ? order by seq',
      )
      .all(this.sandbox, id)
      .map((row) => ({
        seq: row.seq,
        at: row.at,
        statusCode: row.status_code,
        error: row.error,
        durationMs: row.duration_ms,
      }));
  }

  /** Counting in SQL beats materialising every delivery just to tally its status. */
  countByStatus(): Readonly<Record<string, number>> {
    const rows = this.db
      .query<{ status: string; n: number }, [string]>(
        'select status, count(*) as n from webhook_deliveries where sandbox_id = ? group by status',
      )
      .all(this.sandbox);
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = row.n;
    return out;
  }

  recordAttempt(id: WebhookDeliveryId, attempt: Omit<WebhookAttempt, 'seq'>): void {
    this.db
      .query(
        `insert into webhook_attempts (sandbox_id, delivery_id, seq, at, status_code, error, duration_ms)
         values ($sandbox_id, $delivery_id,
           (select coalesce(max(seq), 0) + 1 from webhook_attempts where sandbox_id = $sandbox_id and delivery_id = $delivery_id),
           $at, $status_code, $error, $duration_ms)`,
      )
      .run({
        $sandbox_id: this.sandbox,
        $delivery_id: id,
        $at: attempt.at,
        $status_code: attempt.statusCode,
        $error: attempt.error,
        $duration_ms: attempt.durationMs,
      });
  }
}

export class SqliteFaultStore implements FaultStore {
  constructor(
    private readonly db: Database,
    private readonly sandbox: SandboxId,
  ) {}

  get(): FaultProfile {
    const row = this.db
      .query<
        { latency_ms: number; error_rate: number; unavailable: number; duplicate_webhooks: number; webhook_failure_rate: number },
        [string]
      >('select latency_ms, error_rate, unavailable, duplicate_webhooks, webhook_failure_rate from fault_profiles where sandbox_id = ?')
      .get(this.sandbox);
    return row === null
      ? NO_FAULTS
      : {
          latencyMs: row.latency_ms,
          errorRate: row.error_rate,
          unavailable: row.unavailable === 1,
          duplicateWebhooks: row.duplicate_webhooks === 1,
          webhookFailureRate: row.webhook_failure_rate,
        };
  }

  set(profile: FaultProfile): void {
    this.db
      .query(
        `insert into fault_profiles (sandbox_id, latency_ms, error_rate, unavailable, duplicate_webhooks, webhook_failure_rate)
         values (?, ?, ?, ?, ?, ?)
         on conflict (sandbox_id) do update set latency_ms = excluded.latency_ms, error_rate = excluded.error_rate,
           unavailable = excluded.unavailable, duplicate_webhooks = excluded.duplicate_webhooks,
           webhook_failure_rate = excluded.webhook_failure_rate`,
      )
      .run(
        this.sandbox,
        Math.max(0, Math.trunc(profile.latencyMs)),
        Math.min(Math.max(profile.errorRate, 0), 1),
        profile.unavailable ? 1 : 0,
        profile.duplicateWebhooks ? 1 : 0,
        Math.min(Math.max(profile.webhookFailureRate, 0), 1),
      );
  }
}

export class SqliteDeliveryQueue implements DeliveryQueue {
  constructor(private readonly db: Database) {}

  due(at: number, limit: number): readonly { sandbox: SandboxId; delivery: WebhookDelivery }[] {
    return this.db
      .query<Row, [number, number]>(
        `select ${COLUMNS} from webhook_deliveries
         where status in ('queued', 'retrying') and (next_attempt_at is null or next_attempt_at <= ?)
         order by next_attempt_at, created_at limit ?`,
      )
      .all(at, Math.min(Math.max(limit, 1), 500))
      .map((row) => ({ sandbox: sandboxId(row.sandbox_id), delivery: toDelivery(row) }));
  }
}
