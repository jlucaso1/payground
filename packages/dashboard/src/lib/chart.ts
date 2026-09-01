/** Validated palette (see the dataviz palette reference), light surface #ffffff. */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'] as const;
export const CRITICAL = '#d03b3b';
export const GRID = '#e1e0d9';
export const AXIS = '#c3c2b7';
export const MUTED = '#898781';

export interface TimeBucket {
  start: number;
  end: number;
  total: number;
  errors: number;
}

export interface TimeEvent {
  at: number;
  status: number;
}

export function isError(status: number): boolean {
  return status >= 400;
}

export function timeRange(events: readonly TimeEvent[]): { from: number; to: number } | null {
  let from = Infinity;
  let to = -Infinity;
  for (const event of events) {
    if (!Number.isFinite(event.at)) continue;
    if (event.at < from) from = event.at;
    if (event.at > to) to = event.at;
  }
  if (!Number.isFinite(from)) return null;
  return { from, to: to + 1 };
}

export function bucketByTime(
  events: readonly TimeEvent[],
  from: number,
  to: number,
  count: number,
): TimeBucket[] {
  const n = Math.max(1, Math.floor(count));
  const end = to > from ? to : from + 1;
  const width = (end - from) / n;
  const buckets: TimeBucket[] = [];
  for (let i = 0; i < n; i += 1) {
    buckets.push({ start: from + i * width, end: from + (i + 1) * width, total: 0, errors: 0 });
  }
  for (const event of events) {
    if (event.at < from || event.at > end) continue;
    const raw = Math.floor((event.at - from) / width);
    const index = raw < 0 ? 0 : raw > n - 1 ? n - 1 : raw;
    const bucket = buckets[index];
    if (bucket === undefined) continue;
    bucket.total += 1;
    if (isError(event.status)) bucket.errors += 1;
  }
  return buckets;
}

/** Nearest-rank percentile; p is 0..1. Returns 0 for an empty sample. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = p < 0 ? 0 : p > 1 ? 1 : p;
  const rank = Math.ceil(clamped * sorted.length);
  const index = rank < 1 ? 0 : rank - 1;
  return sorted[index] ?? 0;
}

export function rate(part: number, whole: number): number {
  return whole <= 0 ? 0 : part / whole;
}

/** Smallest 1/2/5 x 10^n at or above value; never zero. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value - candidate * 1e-9) return candidate;
  }
  return 10 * magnitude;
}

/** Largest tick count (<= 5) that keeps every gridline label whole; pass the axis max in integer units. */
export function tickCount(integerMax: number): number {
  const m = Math.round(integerMax);
  if (m <= 0) return 1;
  for (const c of [5, 4, 3, 2]) if (m % c === 0) return c;
  return 1;
}

export function ticks(max: number, count: number): number[] {
  const n = Math.max(1, Math.floor(count));
  const out: number[] = [];
  for (let i = 0; i <= n; i += 1) out.push((max * i) / n);
  return out;
}

/** Rounds to 2 decimals so SVG output is deterministic across platforms. */
export function n2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

export function scaleLength(value: number, max: number, size: number): number {
  if (max <= 0 || !Number.isFinite(value) || value <= 0) return 0;
  const scaled = (value / max) * size;
  return n2(scaled > size ? size : scaled);
}

export interface Band {
  x: number;
  thickness: number;
}

/** Evenly spaced band, capped thickness, centred in its slot. */
export function band(index: number, count: number, width: number, maxThickness = 24): Band {
  const n = Math.max(1, Math.floor(count));
  const slot = width / n;
  const thickness = Math.max(1, Math.min(maxThickness, slot - 2));
  return { x: n2(index * slot + (slot - thickness) / 2), thickness: n2(thickness) };
}

export interface Point {
  x: number;
  y: number;
}

export function linePath(points: readonly Point[]): string {
  if (points.length === 0) return '';
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${n2(p.x)} ${n2(p.y)}`)
    .join(' ');
}

/** UTC HH:MM:SS, matching the deterministic UTC formatting used everywhere else. */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const pad = (v: number): string => String(v).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${Math.round(ms / 100) / 10} s`;
}

export function seriesColor(index: number): string {
  return SERIES[index % SERIES.length] ?? SERIES[0];
}
