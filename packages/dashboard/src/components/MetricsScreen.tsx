import type { ReactNode } from 'react';
import { observability } from '../api/observability.ts';
import type { ApiRequestEntry, RouteMetric } from '../api/types.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { bucketByTime, formatMs, isError, percentile, rate, timeRange } from '../lib/chart.ts';
import { ErrorRateChart, LatencyChart, StatTile, VolumeChart, type LatencyRow } from '../lib/charts.tsx';
import { formatPercent } from '../lib/format.ts';
import { Panel } from '../lib/panel.tsx';
import { ScopeSelect, useScope } from '../lib/scope.tsx';
import { Button, Empty, Section } from './ui.tsx';

const SAMPLE = 200;
const BUCKETS = 24;
const TOP = 8;

function key(metric: RouteMetric): string {
  return `${metric.method} ${metric.route}`;
}

function byCount(a: RouteMetric, b: RouteMetric): number {
  return b.count - a.count || key(a).localeCompare(key(b));
}

function byP95(a: RouteMetric, b: RouteMetric): number {
  return b.p95 - a.p95 || key(a).localeCompare(key(b));
}

function RouteTable({ title, rows }: { title: string; rows: readonly RouteMetric[] }): ReactNode {
  return (
    <div>
      <p className="mb-1 text-xs text-neutral-500 uppercase">{title}</p>
      <table className="w-full text-sm tabular-nums">
        <thead>
          <tr className="text-left text-xs text-neutral-500">
            <th className="py-1 font-normal">Route</th>
            <th className="py-1 text-right font-normal">Count</th>
            <th className="py-1 text-right font-normal">Errors</th>
            <th className="py-1 text-right font-normal">p50</th>
            <th className="py-1 text-right font-normal">p95</th>
            <th className="py-1 text-right font-normal">p99</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((metric) => (
            <tr key={key(metric)} className="border-t border-neutral-200">
              <td className="py-1 font-mono text-xs text-neutral-800">{key(metric)}</td>
              <td className="py-1 text-right">{metric.count}</td>
              <td className="py-1 text-right">{metric.errors}</td>
              <td className="py-1 text-right">{formatMs(metric.p50)}</td>
              <td className="py-1 text-right">{formatMs(metric.p95)}</td>
              <td className="py-1 text-right">{formatMs(metric.p99)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Timeline({ entries }: { entries: readonly ApiRequestEntry[] }): ReactNode {
  const range = timeRange(entries);
  if (range === null) return <Empty>No requests recorded yet.</Empty>;
  const buckets = bucketByTime(entries, range.from, range.to, BUCKETS);
  const durations = entries.map((entry) => entry.durationMs);
  const errors = entries.filter((entry) => isError(entry.status)).length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Sampled requests" value={String(entries.length)} note={`last ${SAMPLE} recorded`} />
        <StatTile label="Errors in sample" value={String(errors)} />
        <StatTile label="Error rate" value={formatPercent(rate(errors, entries.length))} />
        <StatTile label="Latency p95" value={formatMs(percentile(durations, 0.95))} note={`p50 ${formatMs(percentile(durations, 0.5))}`} />
      </div>
      <div>
        <p className="mb-1 text-xs text-neutral-500 uppercase">Request volume</p>
        <VolumeChart buckets={buckets} />
      </div>
      <div>
        <p className="mb-1 text-xs text-neutral-500 uppercase">Error rate</p>
        <ErrorRateChart buckets={buckets} />
      </div>
    </div>
  );
}

export function MetricsScreen(): ReactNode {
  const [scope, setScope] = useScope();
  const metrics = useAsync(() => observability.getMetrics(scope), [scope]);
  const sample = useAsync(
    () => observability.listRequests({ ...(scope === null ? {} : { sandbox: scope }), limit: SAMPLE }),
    [scope],
  );

  const refresh = (): void => {
    metrics.reload();
    sample.reload();
  };

  return (
    <Section
      title="Metrics"
      actions={
        <span className="flex items-center gap-2">
          <ScopeSelect scope={scope} onChange={setScope} />
          <Button onClick={refresh}>Refresh</Button>
        </span>
      }
    >
      <div className="space-y-8">
        <Panel state={sample.state} what="Request history">
          {(page) => <Timeline entries={page.results} />}
        </Panel>
        <Panel state={metrics.state} what="Route metrics">
          {(view) => {
            const busiest = [...view.routes].sort(byCount);
            const slowest = [...view.routes].sort(byP95);
            const rows: LatencyRow[] = busiest.slice(0, TOP).map((metric) => ({
              key: key(metric),
              label: key(metric),
              p50: metric.p50,
              p95: metric.p95,
              p99: metric.p99,
            }));
            return view.routes.length === 0 ? (
              <Empty>No route metrics recorded yet.</Empty>
            ) : (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <StatTile label="Total requests" value={String(view.totals.requests)} />
                  <StatTile label="Total errors" value={String(view.totals.errors)} />
                  <StatTile
                    label="Overall error rate"
                    value={formatPercent(rate(view.totals.errors, view.totals.requests))}
                  />
                </div>
                <div>
                  <p className="mb-1 text-xs text-neutral-500 uppercase">Latency by route</p>
                  <LatencyChart rows={rows} />
                </div>
                <RouteTable title="Busiest routes" rows={busiest.slice(0, 10)} />
                <RouteTable title="Slowest routes" rows={slowest.slice(0, 10)} />
              </div>
            );
          }}
        </Panel>
      </div>
    </Section>
  );
}
