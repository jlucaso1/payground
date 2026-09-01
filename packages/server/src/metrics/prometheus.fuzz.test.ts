import { expect, test } from 'bun:test';
import { SeededRandom } from '@payground/core/testing.ts';
import { exposition } from './prometheus.ts';
import { MetricsRegistry } from './registry.ts';
import { quantile, summarise } from './snapshot.ts';
import { assertHistogramsMonotonic, parseExposition } from './parse.test-util.ts';

const LABEL_NAMES = ['route', 'method', 'status', 'sandbox', 'kind', 'le_ish'];
const VALUES = [
  '',
  '/v1/payments/:id',
  'quote"inside',
  'back\\slash',
  'line\nbreak',
  'ünïcödé 🧾',
  '{braces}',
  'comma,equals=',
  'carriage\rreturn',
  '   ',
  '200',
  '500',
];
const COUNTERS = ['payground_api_requests_total', 'payground_other_requests_total'];
const HISTOGRAMS = ['payground_api_request_duration_ms', 'payground_other_duration_ms'];

const pick = <T>(rng: SeededRandom, items: readonly T[]): T => items[rng.int(items.length)] as T;

function labels(rng: SeededRandom): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = rng.int(LABEL_NAMES.length + 1); i > 0; i--) out[pick(rng, LABEL_NAMES)] = pick(rng, VALUES);
  return out;
}

test('the exposition always parses and the buckets stay monotonic', () => {
  const rng = new SeededRandom(20_260_901);
  const registry = new MetricsRegistry();

  for (let i = 0; i < 3_000; i++) {
    const set = labels(rng);
    if (rng.int(2) === 0) registry.count(pick(rng, COUNTERS), set, rng.int(5) + 1);
    else registry.observe(pick(rng, HISTOGRAMS), set, rng.int(10_000) / 4);
  }

  const gauges = registry
    .counterSamples()
    .slice(0, 20)
    .map((sample) => ({ name: 'payground_webhook_queue_depth', labels: sample.labels, value: rng.int(50) }));

  const parsed = parseExposition(
    exposition({ counters: registry.counterSamples(), gauges, histograms: registry.histogramSamples() }),
  );
  assertHistogramsMonotonic(parsed);

  expect(parsed.series.length).toBeGreaterThan(50);
  expect(Object.values(parsed.types).every((type) => ['counter', 'gauge', 'histogram'].includes(type))).toBe(true);

  for (const sample of registry.histogramSamples()) {
    const p99 = quantile(sample, 0.99);
    expect(p99).not.toBeNull();
    expect(p99 as number).toBeGreaterThanOrEqual(0);
  }

  const summary = summarise(registry, { at: 0 });
  expect(summary.errorRate).toBeGreaterThanOrEqual(0);
  expect(summary.errorRate).toBeLessThanOrEqual(1);
  expect(summary.routes.reduce((total, route) => total + route.requests, 0)).toBe(summary.requests);
});
