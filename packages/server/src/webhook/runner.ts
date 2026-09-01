import { type Clock, type MetricsSink, type RandomSource, type SandboxStore, type WebhookDelivery, noopMetrics } from '@payground/core';
import type { SafeFetchPolicy } from '../net/index.ts';
import { safeFetch } from '../net/index.ts';
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
  metrics?: MetricsSink;
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

  const metrics = options.metrics ?? noopMetrics;
  const labels = { sandbox: String(delivery.sandbox), outcome: updated.status };
  metrics.count('payground_webhook_deliveries_total', labels);
  metrics.observe('payground_webhook_delivery_duration_ms', labels, finished - started);

  return { delivery: updated, statusCode, error };
}

export interface RunnerOptions extends AttemptOptions {
  batchSize?: number;
}

export interface Drainable {
  due(at: number, limit: number): readonly { sandbox: string; delivery: WebhookDelivery }[];
}

/** Delivers everything that is due right now. Returns how many attempts were made. */
export async function drain(
  queue: { due: (at: number, limit: number) => readonly { delivery: WebhookDelivery }[] },
  storeFor: (delivery: WebhookDelivery) => SandboxStore,
  options: RunnerOptions,
): Promise<number> {
  const now = options.clock.now();
  const batch = queue.due(now, options.batchSize ?? 25);

  for (const entry of batch) {
    const store = storeFor(entry.delivery);
    const faults = store.faults.get();
    await attempt(entry.delivery, { ...options, store });
    if (faults.duplicateWebhooks) await attempt(entry.delivery, { ...options, store });
  }

  return batch.length;
}
