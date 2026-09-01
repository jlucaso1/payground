import type { CounterSample, HistogramSample } from './registry.ts';

export interface GaugeSample {
  name: string;
  labels: Readonly<Record<string, string>>;
  value: number;
}

export interface MetricsSnapshot {
  counters: readonly CounterSample[];
  gauges: readonly GaugeSample[];
  histograms: readonly HistogramSample[];
}

export const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Format reference: https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format */
const NAME_START = /^[^a-zA-Z_:]/;
const NAME_REST = /[^a-zA-Z0-9_:]/g;
const LABEL_START = /^[^a-zA-Z_]/;
const LABEL_REST = /[^a-zA-Z0-9_]/g;

const metricName = (name: string): string =>
  (name === '' ? '_' : name).replace(NAME_REST, '_').replace(NAME_START, '_');

const labelName = (name: string): string =>
  (name === '' ? '_' : name).replace(LABEL_REST, '_').replace(LABEL_START, '_');

const escapeLabelValue = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');

/** HELP escapes only the backslash and the newline; a quote is literal there. */
const escapeHelp = (text: string): string => text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

export function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
}

function renderLabels(labels: Readonly<Record<string, string>>, extra?: { name: string; value: string }): string {
  const seen = new Set<string>(extra === undefined ? [] : [extra.name]);
  const parts: string[] = [];
  for (const key of Object.keys(labels).sort()) {
    const name = labelName(key);
    // A sample label colliding with `le` would leave the bucket boundary out of the series.
    if (seen.has(name)) continue;
    seen.add(name);
    parts.push(`${name}="${escapeLabelValue(labels[key] ?? '')}"`);
  }
  if (extra !== undefined) parts.push(`${extra.name}="${escapeLabelValue(extra.value)}"`);
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

type Family =
  | { type: 'counter' | 'gauge'; name: string; series: { labels: Readonly<Record<string, string>>; value: number }[] }
  | { type: 'histogram'; name: string; series: HistogramSample[] };

function group(snapshot: MetricsSnapshot): Family[] {
  const families = new Map<string, Family>();
  const flat = (type: 'counter' | 'gauge', samples: readonly { name: string; labels: Readonly<Record<string, string>>; value: number }[]) => {
    for (const sample of samples) {
      const name = metricName(sample.name);
      let family = families.get(name);
      if (family === undefined) {
        family = { type, name, series: [] };
        families.set(name, family);
      }
      if (family.type !== 'histogram') family.series.push({ labels: sample.labels, value: sample.value });
    }
  };
  flat('counter', snapshot.counters);
  flat('gauge', snapshot.gauges);
  for (const sample of snapshot.histograms) {
    const name = metricName(sample.name);
    let family = families.get(name);
    if (family === undefined) {
      family = { type: 'histogram', name, series: [] };
      families.set(name, family);
    }
    if (family.type === 'histogram') family.series.push(sample);
  }
  return [...families.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Renders the snapshot as Prometheus text. Series that collide after label sanitisation are dropped. */
export function exposition(snapshot: MetricsSnapshot, help: Readonly<Record<string, string>> = {}): string {
  const lines: string[] = [];
  for (const family of group(snapshot)) {
    lines.push(`# HELP ${family.name} ${escapeHelp(help[family.name] ?? family.name)}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    const emitted = new Set<string>();
    if (family.type === 'histogram') {
      for (const sample of family.series) {
        const labels = renderLabels(sample.labels);
        if (emitted.has(labels)) continue;
        emitted.add(labels);
        let running = 0;
        for (const bucket of sample.buckets) {
          running = Math.min(Math.max(running, bucket.count), sample.count);
          lines.push(
            `${family.name}_bucket${renderLabels(sample.labels, { name: 'le', value: formatValue(bucket.le) })} ${running}`,
          );
        }
        lines.push(`${family.name}_bucket${renderLabels(sample.labels, { name: 'le', value: '+Inf' })} ${sample.count}`);
        lines.push(`${family.name}_sum${labels} ${formatValue(sample.sum)}`);
        lines.push(`${family.name}_count${labels} ${sample.count}`);
      }
      continue;
    }
    for (const series of family.series) {
      const labels = renderLabels(series.labels);
      if (emitted.has(labels)) continue;
      emitted.add(labels);
      lines.push(`${family.name}${labels} ${formatValue(series.value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
