import type { Database } from 'bun:sqlite';
import { type SandboxId, type WebhookDeliveryId, sandboxId, webhookDeliveryId } from '@payground/core';
import { ACK_TIMEOUT_MS } from './policy.ts';

/**
 * Long enough for one attempt, doubled for the duplicate-webhook fault, plus slack: a
 * lease that lapses while its holder is still sending would let another instance send the
 * same notification.
 */
export const DEFAULT_LEASE_MS = 2 * ACK_TIMEOUT_MS + 16_000;

export interface LeaseRef {
  sandbox: SandboxId;
  id: WebhookDeliveryId;
}

/** The stamp makes the claim identifiable: only the holder of this exact one may end it. */
export interface Lease extends LeaseRef {
  owner: string;
  until: number;
}

export interface ClaimOptions {
  now: number;
  limit: number;
  owner: string;
  leaseMs?: number;
}

/**
 * The storage package keeps its connection private and exposes no leasing query, so the
 * runner reaches for the same handle rather than opening a second one, two connections to
 * one file would not share the busy timeout or the write lock as cheaply.
 */
export function databaseOf(source: object): Database {
  const db = (source as { db?: Database }).db;
  if (db === undefined) throw new Error('no sqlite connection behind the storage handle');
  return db;
}

const CLAIM = `update webhook_deliveries set leased_until = $until, leased_by = $owner
 where rowid in (
   select rowid from webhook_deliveries
   where (status in ('queued', 'retrying')
            and (next_attempt_at is null or next_attempt_at <= $now)
            and (leased_until is null or leased_until <= $now))
      or (status = 'sending' and leased_until is not null and leased_until <= $now)
   order by next_attempt_at, created_at
   limit $limit)
 returning sandbox_id, id, leased_until`;

const RENEW = `update webhook_deliveries set leased_until = $until
 where sandbox_id = $sandbox and id = $id and leased_by = $owner and leased_until = $held
 returning leased_until`;

const RELEASE = `update webhook_deliveries set leased_until = null, leased_by = null
 where sandbox_id = $sandbox and id = $id and leased_by = $owner and leased_until = $held`;

/**
 * Claims a batch for one owner. `immediate` takes the write lock before the subselect
 * reads, so two processes never see the same unclaimed rows; a plain statement would start
 * on a read snapshot and fail the upgrade with SQLITE_BUSY_SNAPSHOT instead of waiting.
 * A row whose lease has expired is claimable again, including one left `sending` by a
 * crashed instance.
 */
export function claim(db: Database, options: ClaimOptions): readonly Lease[] {
  const until = options.now + (options.leaseMs ?? DEFAULT_LEASE_MS);
  const rows = db
    .transaction(() =>
      db.query<{ sandbox_id: string; id: string; leased_until: number }, [Record<string, string | number>]>(CLAIM).all({
        $now: options.now,
        $until: until,
        $owner: options.owner,
        $limit: Math.min(Math.max(Math.trunc(options.limit), 1), 500),
      }),
    )
    .immediate();
  return rows.map((row) => ({
    sandbox: sandboxId(row.sandbox_id),
    id: webhookDeliveryId(row.id),
    owner: options.owner,
    until: row.leased_until,
  }));
}

/** Extends a lease the caller still holds. Null means someone else has taken the row over. */
export function renew(db: Database, lease: Lease, now: number, leaseMs = DEFAULT_LEASE_MS): Lease | null {
  const until = now + leaseMs;
  const row = db
    .query<{ leased_until: number }, [Record<string, string | number>]>(RENEW)
    .get({ $sandbox: lease.sandbox, $id: lease.id, $owner: lease.owner, $held: lease.until, $until: until });
  return row === null ? null : { ...lease, until: row.leased_until };
}

/** Matched on the stamp as well as the owner, so a lapsed holder cannot free its successor's. */
export function release(db: Database, lease: Lease): void {
  db.query(RELEASE).run({ $sandbox: lease.sandbox, $id: lease.id, $owner: lease.owner, $held: lease.until });
}

export interface LeaseState {
  until: number | null;
  by: string | null;
}

/** Reads the lease columns. Tests assert on them; nothing in the delivery path needs it. */
export function leaseOf(db: Database, ref: LeaseRef): LeaseState | null {
  const row = db
    .query<{ leased_until: number | null; leased_by: string | null }, [string, string]>(
      'select leased_until, leased_by from webhook_deliveries where sandbox_id = ? and id = ?',
    )
    .get(ref.sandbox, ref.id);
  return row === null ? null : { until: row.leased_until, by: row.leased_by };
}
