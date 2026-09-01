import type { ReactNode } from 'react';
import { formatDateTime, formatPercent } from './format.ts';
import {
  AXIS,
  CRITICAL,
  GRID,
  MUTED,
  SERIES,
  band,
  formatClock,
  formatMs,
  linePath,
  n2,
  niceMax,
  rate,
  scaleLength,
  tickCount,
  ticks,
  type TimeBucket,
} from './chart.ts';

const W = 720;
const PAD = { left: 44, right: 16, top: 12, bottom: 22 };

export function Legend({ items }: { items: readonly { color: string; label: string }[] }): ReactNode {
  return (
    <ul className="mb-2 flex flex-wrap gap-4 text-xs text-neutral-600">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export function StatTile({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}): ReactNode {
  return (
    <div className="rounded border border-neutral-200 px-3 py-2">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="text-2xl text-neutral-900 tabular-nums">{value}</p>
      {note === undefined ? null : <p className="text-xs text-neutral-500">{note}</p>}
    </div>
  );
}

function Grid({
  max,
  count,
  height,
  format,
}: {
  max: number;
  count: number;
  height: number;
  format: (v: number) => string;
}): ReactNode {
  const plotW = W - PAD.left - PAD.right;
  return (
    <>
      {ticks(max, count).map((value) => {
        const y = n2(PAD.top + height - scaleLength(value, max, height));
        return (
          <g key={value}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={y} y2={y} stroke={GRID} strokeWidth={1} />
            <text x={PAD.left - 6} y={y + 3} textAnchor="end" fontSize={10} fill={MUTED}>
              {format(value)}
            </text>
          </g>
        );
      })}
    </>
  );
}

function AxisLabels({ buckets, y }: { buckets: readonly TimeBucket[]; y: number }): ReactNode {
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  if (first === undefined || last === undefined) return null;
  return (
    <>
      <text x={PAD.left} y={y} fontSize={10} fill={MUTED}>
        {formatClock(first.start)}
      </text>
      <text x={W - PAD.right} y={y} textAnchor="end" fontSize={10} fill={MUTED}>
        {formatClock(last.end)}
      </text>
    </>
  );
}

/** Requests per bucket, split into succeeded and failed. */
export function VolumeChart({ buckets }: { buckets: readonly TimeBucket[] }): ReactNode {
  const height = 140;
  const plotW = W - PAD.left - PAD.right;
  const max = niceMax(Math.max(...buckets.map((b) => b.total), 1));
  const baseline = PAD.top + height;

  return (
    <figure className="m-0">
      <Legend
        items={[
          { color: SERIES[0], label: 'Succeeded' },
          { color: CRITICAL, label: 'Errors (status >= 400)' },
        ]}
      />
      <svg
        viewBox={`0 0 ${W} ${height + PAD.top + PAD.bottom}`}
        className="w-full"
        role="img"
        aria-label="Request volume over time"
      >
        <Grid max={max} count={tickCount(max)} height={height} format={(v) => String(Math.round(v))} />
        <line x1={PAD.left} x2={PAD.left + plotW} y1={baseline} y2={baseline} stroke={AXIS} strokeWidth={1} />
        {buckets.map((bucket, index) => {
          const slot = band(index, buckets.length, plotW, 16);
          const x = n2(PAD.left + slot.x);
          const errorH = scaleLength(bucket.errors, max, height);
          const okH = scaleLength(bucket.total - bucket.errors, max, height);
          const gap = errorH > 0 && okH > 0 ? 2 : 0;
          return (
            <g key={bucket.start}>
              <title>
                {`${formatDateTime(bucket.start)} · ${bucket.total} requests · ${bucket.errors} errors`}
              </title>
              {okH > 0 ? (
                <rect
                  x={x}
                  y={n2(baseline - okH)}
                  width={slot.thickness}
                  height={okH}
                  fill={SERIES[0]}
                  rx={errorH > 0 ? 0 : 2}
                />
              ) : null}
              {errorH > 0 ? (
                <rect
                  x={x}
                  y={n2(baseline - okH - gap - errorH)}
                  width={slot.thickness}
                  height={errorH}
                  fill={CRITICAL}
                  rx={2}
                />
              ) : null}
              <rect x={x} y={PAD.top} width={slot.thickness} height={height} fill="transparent" />
            </g>
          );
        })}
        <AxisLabels buckets={buckets} y={baseline + 16} />
      </svg>
    </figure>
  );
}

/** Error rate per bucket as a share of that bucket's requests. */
export function ErrorRateChart({ buckets }: { buckets: readonly TimeBucket[] }): ReactNode {
  const height = 110;
  const plotW = W - PAD.left - PAD.right;
  const rates = buckets.map((b) => rate(b.errors, b.total));
  const max = Math.min(1, niceMax(Math.max(...rates, 0.05)));
  const baseline = PAD.top + height;
  const step = buckets.length > 1 ? plotW / (buckets.length - 1) : 0;
  const points = rates.map((value, index) => ({
    x: PAD.left + (buckets.length > 1 ? index * step : plotW / 2),
    y: baseline - scaleLength(value, max, height),
  }));
  const last = points[points.length - 1];
  const lastRate = rates[rates.length - 1] ?? 0;

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${height + PAD.top + PAD.bottom}`}
        className="w-full"
        role="img"
        aria-label="Error rate over time"
      >
        <Grid max={max} count={tickCount(max * 100)} height={height} format={(v) => formatPercent(v)} />
        <line x1={PAD.left} x2={PAD.left + plotW} y1={baseline} y2={baseline} stroke={AXIS} strokeWidth={1} />
        {points.length > 1 ? (
          <path
            d={`${linePath(points)} L${n2(points[points.length - 1]?.x ?? 0)} ${baseline} L${n2(points[0]?.x ?? 0)} ${baseline} Z`}
            fill={CRITICAL}
            fillOpacity={0.1}
          />
        ) : null}
        <path
          d={linePath(points)}
          fill="none"
          stroke={CRITICAL}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {buckets.map((bucket, index) => {
          const point = points[index];
          if (point === undefined) return null;
          return (
            <g key={bucket.start}>
              <title>
                {`${formatDateTime(bucket.start)} · ${formatPercent(rates[index] ?? 0)} of ${bucket.total}`}
              </title>
              <circle cx={n2(point.x)} cy={n2(point.y)} r={6} fill="transparent" />
            </g>
          );
        })}
        {last === undefined ? null : (
          <>
            <circle cx={n2(last.x)} cy={n2(last.y)} r={4} fill={CRITICAL} stroke="#ffffff" strokeWidth={2} />
            <text x={n2(last.x) - 6} y={n2(last.y) - 8} textAnchor="end" fontSize={10} fill="#52514e">
              {formatPercent(lastRate)}
            </text>
          </>
        )}
        <AxisLabels buckets={buckets} y={baseline + 16} />
      </svg>
    </figure>
  );
}

export interface LatencyRow {
  key: string;
  label: string;
  p50: number;
  p95: number;
  p99: number;
}

/** Grouped horizontal bars: p50 / p95 / p99 per route. */
export function LatencyChart({ rows }: { rows: readonly LatencyRow[] }): ReactNode {
  const labelW = 210;
  const barW = W - labelW - 60;
  const rowH = 34;
  const bar = 7;
  const max = niceMax(Math.max(...rows.map((r) => r.p99), 1));
  const height = rows.length * rowH + 20;

  return (
    <figure className="m-0">
      <Legend
        items={[
          { color: SERIES[0], label: 'p50' },
          { color: SERIES[1], label: 'p95' },
          { color: SERIES[2], label: 'p99' },
        ]}
      />
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="w-full"
        role="img"
        aria-label="Latency percentiles per route"
      >
        {ticks(max, tickCount(max)).map((value) => {
          const x = n2(labelW + scaleLength(value, max, barW));
          return (
            <g key={value}>
              <line x1={x} x2={x} y1={0} y2={rows.length * rowH} stroke={GRID} strokeWidth={1} />
              <text x={x} y={height - 6} textAnchor="middle" fontSize={10} fill={MUTED}>
                {formatMs(value)}
              </text>
            </g>
          );
        })}
        {rows.map((row, index) => {
          const top = index * rowH + 4;
          return (
            <g key={row.key}>
              <text x={0} y={top + 12} fontSize={11} fill="#52514e">
                {row.label.length > 34 ? `${row.label.slice(0, 33)}…` : row.label}
              </text>
              {([row.p50, row.p95, row.p99] as const).map((value, i) => {
                const width = scaleLength(value, max, barW);
                return (
                  <g key={i}>
                    <title>{`${row.label} · ${['p50', 'p95', 'p99'][i]} ${formatMs(value)}`}</title>
                    <rect
                      x={labelW}
                      y={top + i * (bar + 2)}
                      width={Math.max(width, 1)}
                      height={bar}
                      fill={SERIES[i] ?? SERIES[0]}
                      rx={2}
                    />
                  </g>
                );
              })}
              <text
                x={n2(labelW + scaleLength(row.p99, max, barW)) + 6}
                y={top + 2 * (bar + 2) + bar}
                fontSize={10}
                fill="#52514e"
              >
                {formatMs(row.p99)}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
