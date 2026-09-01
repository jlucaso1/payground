import type { DeliveryStatus, SandboxId } from '@payground/core';
import type { Storage } from '@payground/storage';
import type { CounterSample, HistogramSample } from './registry.ts';
import type { GaugeSample, MetricsSnapshot } from './prometheus.ts';

export const REQUESTS_TOTAL = 'payground_api_requests_total';
export const REQUEST_DURATION = 'payground_api_request_duration_ms';
export const WEBHOOK_DELIVERIES = 'payground_webhook_deliveries';
export const WEBHOOK_QUEUE_DEPTH = 'payground_webhook_queue_depth';

export const HELP: Readonly<Record<string, string>> = {
  [REQUESTS_TOTAL]: 'Emulated API requests served, by route, method, status and sandbox.',
  [REQUEST_DURATION]: 'Emulated API request latency in milliseconds.',
  [WEBHOOK_DELIVERIES]:
    'Stored webhook deliveries by sandbox and current outcome. A gauge, not a counter: a delivery moves between statuses.',
  [WEBHOOK_QUEUE_DEPTH]: 'Webhook deliveries still waiting to be delivered, by sandbox.',
};

/** The read side of `MetricsRegistry`; the app only requires a `MetricsSink`, so this is checked at runtime. */
export interface MetricsReader {
  counterSamples(): readonly CounterSample[];
  histogramSamples(): readonly HistogramSample[];
}

export const asReader = (sink: unknown): MetricsReader | null => {
  const candidate = sink as Partial<MetricsReader> | null;
  return typeof candidate?.counterSamples === 'function' && typeof candidate.histogramSamples === 'function'
    ? (candidate as MetricsReader)
    : null;
};

const STATUSES: readonly DeliveryStatus[] = ['queued', 'sending', 'delivered', 'retrying', 'exhausted'];
const PENDING: readonly DeliveryStatus[] = ['queued', 'sending', 'retrying'];

export interface WebhookStats {
  queueDepth: number;
  byStatus: Record<DeliveryStatus, number>;
}

/** Counted in SQL, so the gauge is exact rather than capped at a page of deliveries. */
export function webhookStats(storage: Storage, sandbox: SandboxId): WebhookStats {
  const counted = storage.forSandbox(sandbox).webhooks.countByStatus();
  const byStatus = Object.fromEntries(
    STATUSES.map((status) => [status, counted[status] ?? 0]),
  ) as Record<DeliveryStatus, number>;
  return { queueDepth: PENDING.reduce((total, status) => total + byStatus[status], 0), byStatus };
}

export function snapshot(reader: MetricsReader, storage: Storage): MetricsSnapshot {
  const gauges: GaugeSample[] = [];
  for (const sandbox of storage.sandboxes.list()) {
    const stats = webhookStats(storage, sandbox.id);
    gauges.push({ name: WEBHOOK_QUEUE_DEPTH, labels: { sandbox: sandbox.id }, value: stats.queueDepth });
    for (const status of STATUSES) {
      gauges.push({ name: WEBHOOK_DELIVERIES, labels: { sandbox: sandbox.id, status }, value: stats.byStatus[status] });
    }
  }
  return { counters: reader.counterSamples(), gauges, histograms: reader.histogramSamples() };
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Prometheus-style bucket interpolation, assuming a lower bound of zero for the first bucket.
 * Returns null for an empty histogram and the largest finite bound when the quantile falls in +Inf.
 */
export function quantile(sample: Pick<HistogramSample, 'count' | 'buckets'>, q: number): number | null {
  if (sample.count === 0) return null;
  const rank = q * sample.count;
  let lowerBound = 0;
  let lowerCount = 0;
  for (const bucket of sample.buckets) {
    if (bucket.count >= rank) {
      if (bucket.count === lowerCount) return round(lowerBound);
      return round(lowerBound + (bucket.le - lowerBound) * ((rank - lowerCount) / (bucket.count - lowerCount)));
    }
    lowerBound = bucket.le;
    lowerCount = bucket.count;
  }
  return round(lowerBound);
}

function merge(samples: readonly HistogramSample[]): Pick<HistogramSample, 'count' | 'sum' | 'buckets'> {
  const buckets = new Map<number, number>();
  let count = 0;
  let sum = 0;
  for (const sample of samples) {
    count += sample.count;
    sum += sample.sum;
    for (const bucket of sample.buckets) buckets.set(bucket.le, (buckets.get(bucket.le) ?? 0) + bucket.count);
  }
  return {
    count,
    sum,
    buckets: [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([le, total]) => ({ le, count: total })),
  };
}

export interface LatencySummary {
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface RouteSummary {
  route: string;
  method: string;
  requests: number;
  errors: number;
  errorRate: number;
  latency: LatencySummary;
}

export interface Summary {
  at: number;
  requests: number;
  errors: number;
  errorRate: number;
  latency: LatencySummary;
  routes: readonly RouteSummary[];
}

const latency = (samples: readonly HistogramSample[]): LatencySummary => {
  const merged = merge(samples);
  return { p50: quantile(merged, 0.5), p95: quantile(merged, 0.95), p99: quantile(merged, 0.99) };
};

const isError = (status: string): boolean => Number(status) >= 400;

const rate = (errors: number, total: number): number => (total === 0 ? 0 : round(errors / total));

export interface SummaryOptions {
  at: number;
  /** Restricts the rollup to one sandbox. */
  sandbox?: SandboxId;
}

export function summarise(reader: MetricsReader, options: SummaryOptions): Summary {
  const wanted = (labels: Readonly<Record<string, string>>): boolean =>
    options.sandbox === undefined || labels['sandbox'] === options.sandbox;

  const counters = reader.counterSamples().filter((c) => c.name === REQUESTS_TOTAL && wanted(c.labels));
  const histograms = reader.histogramSamples().filter((h) => h.name === REQUEST_DURATION && wanted(h.labels));

  const routes = new Map<string, { route: string; method: string; requests: number; errors: number; samples: HistogramSample[] }>();
  for (const counter of counters) {
    const route = counter.labels['route'] ?? '';
    const method = counter.labels['method'] ?? '';
    const key = `${method} ${route}`;
    const entry = routes.get(key) ?? { route, method, requests: 0, errors: 0, samples: [] };
    entry.requests += counter.value;
    if (isError(counter.labels['status'] ?? '')) entry.errors += counter.value;
    routes.set(key, entry);
  }
  for (const histogram of histograms) {
    const key = `${histogram.labels['method'] ?? ''} ${histogram.labels['route'] ?? ''}`;
    routes.get(key)?.samples.push(histogram);
  }

  const requests = counters.reduce((total, c) => total + c.value, 0);
  const errors = counters.reduce((total, c) => total + (isError(c.labels['status'] ?? '') ? c.value : 0), 0);

  return {
    at: options.at,
    requests,
    errors,
    errorRate: rate(errors, requests),
    latency: latency(histograms),
    routes: [...routes.values()]
      .sort((a, b) => b.requests - a.requests || `${a.route} ${a.method}`.localeCompare(`${b.route} ${b.method}`))
      .map(({ samples, ...entry }) => ({
        ...entry,
        errorRate: rate(entry.errors, entry.requests),
        latency: latency(samples),
      })),
  };
}
