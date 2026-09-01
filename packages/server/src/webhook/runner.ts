import type { Clock, DeliveryQueue, RandomSource, SandboxId, SandboxStore, WebhookDelivery } from '@payground/core';
import type { SafeFetchPolicy } from '../net/index.ts';
import { safeFetch } from '../net/index.ts';
import { type Lease, claim, databaseOf, release, renew } from './lease.ts';
import { ACK_TIMEOUT_MS, type RetryPolicy, DEFAULT_RETRY_POLICY, nextAttemptAt } from './policy.ts';

export interface DeliveryResult {
  delivery: WebhookDelivery;
  statusCode: number | null;
  error: string | null;
}

export interface AttemptOptions {
  store: SandboxStore;
  clock: Clock;
  random: RandomSource;
  policy?: RetryPolicy;
  net?: SafeFetchPolicy;
}

const isSuccess = (status: number): boolean => status === 200 || status === 201;

/** Runs one attempt and persists the outcome. Never throws. */
export async function attempt(
  delivery: WebhookDelivery,
  options: AttemptOptions,
): Promise<DeliveryResult> {
  const { store, clock, random } = options;
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const started = clock.now();
  const faults = store.faults.get();

  store.webhooks.update({ ...delivery, status: 'sending', updatedAt: started });

  let statusCode: number | null = null;
  let error: string | null = null;
  let responseBody: string | null = null;

  const injectFailure = faults.webhookFailureRate > 0 && random.int(10_000) < faults.webhookFailureRate * 10_000;

  if (injectFailure) {
    error = 'injected webhook failure';
  } else {
    const response = await safeFetch(
      {
        url: delivery.url,
        method: 'POST',
        headers: delivery.requestHeaders,
        body: delivery.requestBody,
        timeoutMs: ACK_TIMEOUT_MS,
      },
      options.net,
    );
    if (response.ok) {
      statusCode = response.value.status;
      responseBody = response.value.body.slice(0, 4_096);
    } else {
      error = `${response.error.kind}: ${JSON.stringify(response.error)}`;
    }
  }

  const finished = clock.now();
  const attempts = delivery.attempts + 1;
  store.webhooks.recordAttempt(delivery.id, {
    at: started,
    statusCode,
    error,
    durationMs: finished - started,
  });

  const delivered = statusCode !== null && isSuccess(statusCode);
  const retryAt = delivered ? null : nextAttemptAt(attempts, finished, policy);

  const updated: WebhookDelivery = {
    ...delivery,
    attempts,
    status: delivered ? 'delivered' : retryAt === null ? 'exhausted' : 'retrying',
    lastStatusCode: statusCode,
    lastError: error,
    responseBody,
    nextAttemptAt: retryAt,
    updatedAt: finished,
  };
  store.webhooks.update(updated);

  return { delivery: updated, statusCode, error };
}

export interface RunnerOptions extends AttemptOptions {
  batchSize?: number;
  /** Identifies this instance in the lease. Defaults to the process id. */
  owner?: string;
  leaseMs?: number;
}

/**
 * Names the instance in the lease. Correctness does not rest on it being unique — a lease
 * is ended only by the holder of its exact expiry stamp — so a process id, which needs
 * neither the clock nor randomness, is enough to tell instances apart while reading rows.
 */
const INSTANCE = `pid-${process.pid}`;

/**
 * Delivers everything that is due right now. Returns how many deliveries were attempted.
 * Every delivery is claimed with a lease first, so instances sharing a database file never
 * send the same notification twice. Never throws: the caller drives it from a timer.
 */
export async function drain(
  queue: DeliveryQueue,
  storeFor: (ref: { sandbox: SandboxId }) => SandboxStore,
  options: RunnerOptions,
): Promise<number> {
  const db = databaseOf(queue);
  const owner = options.owner ?? INSTANCE;
  let claimed: readonly Lease[];
  try {
    claimed = claim(db, {
      now: options.clock.now(),
      limit: options.batchSize ?? 25,
      owner,
      ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
    });
  } catch {
    // Another instance holds the write lock for longer than the busy timeout; the next tick retries.
    return 0;
  }

  let attempted = 0;
  for (const lease of claimed) {
    try {
      const store = storeFor(lease);
      const delivery = store.webhooks.get(lease.id);
      if (delivery === null) {
        release(db, lease);
        continue;
      }
      // The batch is delivered one at a time and an unreachable target holds the loop for
      // the whole ack timeout, so the lease is stretched again right before each attempt.
      const held = renew(db, lease, options.clock.now(), options.leaseMs);
      if (held === null) continue;

      const faults = store.faults.get();
      await attempt(delivery, { ...options, store });
      if (faults.duplicateWebhooks) await attempt(delivery, { ...options, store });
      attempted += 1;
      release(db, held);
    } catch {
      // Keep the lease: an attempt that died halfway is reclaimable once it expires, the
      // same way a crashed instance is. Releasing here would strand a `sending` row.
    }
  }

  return attempted;
}
