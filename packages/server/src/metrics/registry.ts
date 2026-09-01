import type { MetricsSink } from '@payground/core';

export interface CounterSample {
  name: string;
  labels: Readonly<Record<string, string>>;
  value: number;
}

export interface HistogramSample {
  name: string;
  labels: Readonly<Record<string, string>>;
  count: number;
  sum: number;
  buckets: readonly { le: number; count: number }[];
}

/** Latency buckets in milliseconds, from a fast local call to a very slow one. */
export const DEFAULT_BUCKETS: readonly number[] = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

const key = (name: string, labels: Readonly<Record<string, string>>): string => {
  // JSON-encoded so a value containing a separator cannot collide with a different label set.
  const parts = Object.keys(labels)
    .sort()
    .map((label) => `${JSON.stringify(label)}:${JSON.stringify(labels[label] ?? '')}`);
  return `${JSON.stringify(name)} ${parts.join(',')}`;
};

interface Series {
  name: string;
  labels: Readonly<Record<string, string>>;
  value: number;
}

interface Distribution {
  name: string;
  labels: Readonly<Record<string, string>>;
  count: number;
  sum: number;
  buckets: number[];
}

/** In-process registry. Counters and histograms only — no gauges are needed yet. */
export class MetricsRegistry implements MetricsSink {
  private readonly counters = new Map<string, Series>();
  private readonly histograms = new Map<string, Distribution>();

  constructor(private readonly buckets: readonly number[] = DEFAULT_BUCKETS) {}

  count(name: string, labels: Readonly<Record<string, string>>, delta = 1): void {
    const id = key(name, labels);
    const existing = this.counters.get(id);
    if (existing === undefined) this.counters.set(id, { name, labels, value: delta });
    else existing.value += delta;
  }

  observe(name: string, labels: Readonly<Record<string, string>>, value: number): void {
    const id = key(name, labels);
    let entry = this.histograms.get(id);
    if (entry === undefined) {
      entry = { name, labels, count: 0, sum: 0, buckets: this.buckets.map(() => 0) };
      this.histograms.set(id, entry);
    }
    entry.count += 1;
    entry.sum += value;
    this.buckets.forEach((bound, index) => {
      if (value <= bound) entry.buckets[index] = (entry.buckets[index] ?? 0) + 1;
    });
  }

  counterSamples(): readonly CounterSample[] {
    return [...this.counters.values()].map((series) => ({ ...series }));
  }

  histogramSamples(): readonly HistogramSample[] {
    return [...this.histograms.values()].map((entry) => ({
      name: entry.name,
      labels: entry.labels,
      count: entry.count,
      sum: entry.sum,
      buckets: this.buckets.map((le, index) => ({ le, count: entry.buckets[index] ?? 0 })),
    }));
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
  }
}
