export interface ParsedSeries {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface Parsed {
  help: Record<string, string>;
  types: Record<string, string>;
  series: ParsedSeries[];
}

const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})? (.+)$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/y;

function labels(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = source.slice(1, -1);
  LABEL.lastIndex = 0;
  while (LABEL.lastIndex < body.length) {
    const match = LABEL.exec(body);
    if (match === null) throw new Error(`bad label set: ${source}`);
    const name = match[1] as string;
    if (name in out) throw new Error(`duplicate label ${name} in ${source}`);
    out[name] = (match[2] as string).replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c));
    if (body[LABEL.lastIndex] === ',') LABEL.lastIndex += 1;
    else if (LABEL.lastIndex !== body.length) throw new Error(`bad label set: ${source}`);
  }
  return out;
}

/** Strict-enough parser for the text exposition format, used to prove the output is well formed. */
export function parseExposition(text: string): Parsed {
  const parsed: Parsed = { help: {}, types: {}, series: [] };
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    if (line.startsWith('# ')) {
      const [, kind, name, ...rest] = line.split(' ');
      if (kind === 'HELP') parsed.help[name as string] = rest.join(' ');
      else if (kind === 'TYPE') parsed.types[name as string] = rest.join(' ');
      else throw new Error(`unknown comment: ${line}`);
      continue;
    }
    const match = SAMPLE.exec(line);
    if (match === null) throw new Error(`bad sample line: ${line}`);
    const name = match[1] as string;
    const set = match[2] === undefined ? {} : labels(match[2]);
    const raw = match[3] as string;
    const value = raw === '+Inf' ? Number.POSITIVE_INFINITY : raw === 'NaN' ? Number.NaN : Number(raw);
    if (raw !== 'NaN' && Number.isNaN(value)) throw new Error(`bad value: ${line}`);
    const key = `${name}${JSON.stringify(Object.entries(set).sort())}`;
    if (seen.has(key)) throw new Error(`duplicate series: ${line}`);
    seen.add(key);
    parsed.series.push({ name, labels: set, value });
  }
  return parsed;
}

/** Every histogram's buckets must be non-decreasing and end at `_count`. */
export function assertHistogramsMonotonic(parsed: Parsed): void {
  const groups = new Map<string, { le: string; value: number }[]>();
  const counts = new Map<string, number>();
  for (const series of parsed.series) {
    const { le, ...rest } = series.labels;
    const key = `${series.name.replace(/_(bucket|sum|count)$/, '')}${JSON.stringify(Object.entries(rest).sort())}`;
    if (series.name.endsWith('_bucket')) {
      const bucket = groups.get(key) ?? [];
      bucket.push({ le: le as string, value: series.value });
      groups.set(key, bucket);
    } else if (series.name.endsWith('_count')) counts.set(key, series.value);
  }
  for (const [key, buckets] of groups) {
    let previous = 0;
    for (const bucket of buckets) {
      if (bucket.value < previous) throw new Error(`bucket counts decrease for ${key}`);
      previous = bucket.value;
    }
    const last = buckets[buckets.length - 1];
    if (last?.le !== '+Inf') throw new Error(`missing +Inf bucket for ${key}`);
    if (counts.get(key) !== last.value) throw new Error(`+Inf does not match _count for ${key}`);
  }
}
