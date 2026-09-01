import { describe, expect, test } from 'bun:test';
import { exposition, formatValue } from './prometheus.ts';
import { MetricsRegistry } from './registry.ts';
import { quantile, summarise } from './snapshot.ts';
import { assertHistogramsMonotonic, parseExposition } from './parse.test-util.ts';

const REQUESTS = 'payground_api_requests_total';
const DURATION = 'payground_api_request_duration_ms';

const labels = (status: string, route = '/v1/payments', method = 'POST') => ({
  route,
  method,
  status,
  sandbox: 'sbx_1',
});

describe('exposition', () => {
  test('renders help, type and one line per counter series', () => {
    const registry = new MetricsRegistry();
    registry.count(REQUESTS, labels('201'));
    registry.count(REQUESTS, labels('201'));
    registry.count(REQUESTS, labels('404'));

    const text = exposition(
      { counters: registry.counterSamples(), gauges: [], histograms: [] },
      { [REQUESTS]: 'served requests' },
    );

    expect(text).toContain(`# HELP ${REQUESTS} served requests`);
    expect(text).toContain(`# TYPE ${REQUESTS} counter`);
    expect(text).toContain(`${REQUESTS}{method="POST",route="/v1/payments",sandbox="sbx_1",status="201"} 2`);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n').filter((line) => line.startsWith(`# TYPE ${REQUESTS} `))).toHaveLength(1);
  });

  test('renders cumulative buckets ending at +Inf, plus sum and count', () => {
    const registry = new MetricsRegistry([1, 10]);
    registry.observe(DURATION, { route: '/a' }, 0.5);
    registry.observe(DURATION, { route: '/a' }, 5);
    registry.observe(DURATION, { route: '/a' }, 5_000);

    const text = exposition({ counters: [], gauges: [], histograms: registry.histogramSamples() });
    expect(text).toContain(`# TYPE ${DURATION} histogram`);
    expect(text).toContain(`${DURATION}_bucket{route="/a",le="1"} 1`);
    expect(text).toContain(`${DURATION}_bucket{route="/a",le="10"} 2`);
    expect(text).toContain(`${DURATION}_bucket{route="/a",le="+Inf"} 3`);
    expect(text).toContain(`${DURATION}_sum{route="/a"} 5005.5`);
    expect(text).toContain(`${DURATION}_count{route="/a"} 3`);
    assertHistogramsMonotonic(parseExposition(text));
  });

  test('escapes backslashes, quotes and line breaks in label values', () => {
    const text = exposition({
      counters: [{ name: 'x_total', labels: { path: 'a\\b"c\nd\re' }, value: 1 }],
      gauges: [],
      histograms: [],
    });
    expect(text).toContain('x_total{path="a\\\\b\\"c\\nd\\re"} 1');
    expect(text.split('\n')).toHaveLength(4);
    expect(parseExposition(text).series[0]?.labels['path']).toBe('a\\b"c\nd\re');
  });

  test('a sample label named le never displaces the bucket boundary', () => {
    const registry = new MetricsRegistry([1]);
    registry.observe(DURATION, { le: 'mine' }, 0.5);
    const text = exposition({ counters: [], gauges: [], histograms: registry.histogramSamples() });
    expect(text).toContain(`${DURATION}_bucket{le="1"} 1`);
    assertHistogramsMonotonic(parseExposition(text));
  });

  test('sanitises names and never emits the same series twice', () => {
    const text = exposition({
      counters: [
        { name: '9bad-name', labels: { 'a-b': '1', 'a.b': 'shadowed' }, value: 1 },
        { name: '9bad-name', labels: { 'a.b': '1' }, value: 7 },
      ],
      gauges: [],
      histograms: [],
    });
    const parsed = parseExposition(text);
    expect(parsed.series).toHaveLength(1);
    expect(parsed.series[0]?.name).toBe('_bad_name');
    expect(parsed.types['_bad_name']).toBe('counter');
  });

  test('a gauge keeps its own type', () => {
    const text = exposition({ counters: [], gauges: [{ name: 'q_depth', labels: {}, value: 3 }], histograms: [] });
    expect(text).toContain('# TYPE q_depth gauge\nq_depth 3\n');
  });

  test('formats the special float values the way the format requires', () => {
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe('+Inf');
    expect(formatValue(Number.NEGATIVE_INFINITY)).toBe('-Inf');
    expect(formatValue(Number.NaN)).toBe('NaN');
    expect(formatValue(1.5)).toBe('1.5');
  });
});

describe('quantile', () => {
  const sample = (counts: number[], count: number) => ({
    count,
    buckets: [1, 10, 100].map((le, index) => ({ le, count: counts[index] ?? 0 })),
  });

  test('is null while nothing has been observed', () => {
    expect(quantile(sample([0, 0, 0], 0), 0.5)).toBeNull();
  });

  test('interpolates inside the matching bucket', () => {
    expect(quantile(sample([0, 10, 10], 10), 0.5)).toBe(5.5);
  });

  test('falls back to the largest finite bound when the quantile lands in +Inf', () => {
    expect(quantile(sample([0, 0, 0], 4), 0.99)).toBe(100);
  });
});

describe('summarise', () => {
  const registry = new MetricsRegistry();
  registry.count(REQUESTS, labels('201'));
  registry.count(REQUESTS, labels('500'));
  registry.count(REQUESTS, { ...labels('200', '/v1/payments/search', 'GET'), sandbox: 'sbx_2' });
  registry.observe(DURATION, labels('201'), 3);
  registry.observe(DURATION, labels('500'), 40);
  registry.observe(DURATION, { ...labels('200', '/v1/payments/search', 'GET'), sandbox: 'sbx_2' }, 7);

  test('totals requests, errors and the error rate', () => {
    const summary = summarise(registry, { at: 5 });
    expect(summary).toMatchObject({ at: 5, requests: 3, errors: 1, errorRate: 0.333 });
    expect(summary.latency.p50).toBeGreaterThan(0);
  });

  test('groups per route and method', () => {
    const routes = summarise(registry, { at: 0 }).routes;
    expect(routes[0]).toMatchObject({ route: '/v1/payments', method: 'POST', requests: 2, errors: 1, errorRate: 0.5 });
    expect(routes[1]).toMatchObject({ route: '/v1/payments/search', requests: 1, errorRate: 0 });
  });

  test('a sandbox rollup only counts that sandbox', () => {
    const summary = summarise(registry, { at: 0, sandbox: 'sbx_2' as never });
    expect(summary.requests).toBe(1);
    expect(summary.errors).toBe(0);
    expect(summary.routes).toHaveLength(1);
    expect(summary.routes[0]?.route).toBe('/v1/payments/search');
  });
});
