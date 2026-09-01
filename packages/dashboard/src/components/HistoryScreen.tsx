import { useState, type ReactNode } from 'react';
import { observability } from '../api/observability.ts';
import type { ApiRequestEntry, AuditEntry } from '../api/types.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { formatMs, isError } from '../lib/chart.ts';
import { useDebounced } from '../lib/debounce.ts';
import { formatDateTime } from '../lib/format.ts';
import { Panel } from '../lib/panel.tsx';
import { ScopeSelect, useScope } from '../lib/scope.tsx';
import { Badge, Button, Empty, Mono, Pre, Section, inputClass, prettyJson } from './ui.tsx';

const PAGE_SIZE = 25;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const WINDOWS = [
  { label: 'All time', ms: 0 },
  { label: 'Last 15 minutes', ms: 15 * 60_000 },
  { label: 'Last hour', ms: 60 * 60_000 },
  { label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
] as const;

function Pager({
  total,
  offset,
  onOffset,
}: {
  total: number;
  offset: number;
  onOffset: (next: number) => void;
}): ReactNode {
  const shown = Math.min(offset + PAGE_SIZE, total);
  return (
    <div className="mt-3 flex items-center gap-3 text-sm text-neutral-600">
      <Button disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - PAGE_SIZE))}>
        Previous
      </Button>
      <Button disabled={shown >= total} onClick={() => onOffset(offset + PAGE_SIZE)}>
        Next
      </Button>
      <span>
        {total === 0 ? 0 : offset + 1}–{shown} of {total}
      </span>
    </div>
  );
}

function StatusText({ status }: { status: number }): ReactNode {
  return (
    <span className={isError(status) ? 'font-medium text-red-700' : 'text-neutral-800'}>{status}</span>
  );
}

function RequestDetail({ id }: { id: string }): ReactNode {
  const { state } = useAsync(() => observability.getRequest(id), [id]);
  return (
    <Panel state={state}>
      {(entry) => (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-3">
            <span
              className={`text-3xl tabular-nums ${isError(entry.status) ? 'text-red-700' : 'text-neutral-900'}`}
            >
              {entry.status}
            </span>
            <Badge>{entry.method}</Badge>
            <Mono>{entry.path}</Mono>
            <span className="text-sm text-neutral-600">{formatMs(entry.durationMs)}</span>
            <span className="text-sm text-neutral-500">{formatDateTime(entry.at)}</span>
          </div>
          <p className="text-xs text-neutral-500">
            route: <Mono>{entry.route}</Mono>
            {entry.sandbox === null ? null : (
              <>
                {' · sandbox: '}
                <Mono>{entry.sandbox}</Mono>
              </>
            )}
            {entry.idempotencyKey === null ? null : (
              <>
                {' · idempotency: '}
                <Mono>{entry.idempotencyKey}</Mono>
              </>
            )}
            {entry.userAgent === null ? null : ` · ${entry.userAgent}`}
          </p>
          <div>
            <p className="mb-1 text-xs text-neutral-500 uppercase">Request body</p>
            <Pre>{entry.requestBody === null ? '—' : prettyJson(entry.requestBody)}</Pre>
          </div>
          <div>
            <p className="mb-1 text-xs text-neutral-500 uppercase">Response body</p>
            <Pre>{entry.responseBody === null ? '—' : prettyJson(entry.responseBody)}</Pre>
          </div>
        </div>
      )}
    </Panel>
  );
}

function RequestRow({
  entry,
  open,
  onToggle,
}: {
  entry: ApiRequestEntry;
  open: boolean;
  onToggle: () => void;
}): ReactNode {
  return (
    <li className="rounded border border-neutral-200 p-3">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-3 text-left text-sm"
      >
        <Badge>{entry.method}</Badge>
        <StatusText status={entry.status} />
        <Mono>{entry.route}</Mono>
        <span className="text-neutral-600 tabular-nums">{formatMs(entry.durationMs)}</span>
        {entry.sandbox === null ? null : <span className="text-neutral-500">{entry.sandbox}</span>}
        <span className="ml-auto text-neutral-500">{formatDateTime(entry.at)}</span>
      </button>
      {open ? (
        <div className="mt-3 border-t border-neutral-200 pt-3">
          <RequestDetail id={entry.id} />
        </div>
      ) : null}
    </li>
  );
}

function RequestsTab({ scope }: { scope: string | null }): ReactNode {
  const [method, setMethod] = useState('');
  const [route, setRoute] = useState('');
  const [status, setStatus] = useState('');
  const [minStatus, setMinStatus] = useState('');
  const [windowMs, setWindowMs] = useState(0);
  const [since, setSince] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const settledRoute = useDebounced(route);
  const statusValid = status === '' || /^\d{3}$/.test(status);
  const statusValue = statusValid && status !== '' ? Number(status) : undefined;
  const minStatusValue = minStatus === '' ? undefined : Number(minStatus);

  const { state, reload } = useAsync(
    () =>
      observability.listRequests({
        ...(scope === null ? {} : { sandbox: scope }),
        ...(method === '' ? {} : { method }),
        ...(settledRoute === '' ? {} : { route: settledRoute }),
        ...(statusValue === undefined ? {} : { status: statusValue }),
        ...(minStatusValue === undefined ? {} : { min_status: minStatusValue }),
        ...(since === null ? {} : { from: since }),
        limit: PAGE_SIZE,
        offset,
      }),
    [scope, method, settledRoute, statusValue, minStatusValue, since, offset],
  );

  const reset = (): void => {
    setOffset(0);
    setOpenId(null);
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <select
          className={inputClass}
          aria-label="Method"
          value={method}
          onChange={(event) => {
            setMethod(event.target.value);
            reset();
          }}
        >
          <option value="">All methods</option>
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          className={inputClass}
          placeholder="Route (e.g. /v1/payments)"
          value={route}
          onChange={(event) => {
            setRoute(event.target.value);
            reset();
          }}
        />
        <input
          className={statusValid ? inputClass : `${inputClass} !border-red-500 text-red-700`}
          placeholder="Status (e.g. 201)"
          title={statusValid ? undefined : 'Enter a three-digit status'}
          aria-invalid={!statusValid}
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            reset();
          }}
        />
        <select
          className={inputClass}
          aria-label="Minimum status"
          value={minStatus}
          onChange={(event) => {
            setMinStatus(event.target.value);
            reset();
          }}
        >
          <option value="">Any outcome</option>
          <option value="400">Errors (&gt;= 400)</option>
          <option value="500">Server errors (&gt;= 500)</option>
        </select>
        <select
          className={inputClass}
          aria-label="Time window"
          value={String(windowMs)}
          onChange={(event) => {
            const ms = Number(event.target.value);
            setWindowMs(ms);
            setSince(ms === 0 ? null : Date.now() - ms);
            reset();
          }}
        >
          {WINDOWS.map((w) => (
            <option key={w.ms} value={String(w.ms)}>
              {w.label}
            </option>
          ))}
        </select>
        <Button
          onClick={() => {
            if (windowMs !== 0) setSince(Date.now() - windowMs);
            reload();
          }}
        >
          Refresh
        </Button>
      </div>
      <Panel state={state} what="The request log">
        {(page) => (
          <>
            {page.results.length === 0 ? (
              <Empty>No requests match these filters.</Empty>
            ) : (
              <ul className="space-y-2">
                {page.results.map((entry) => (
                  <RequestRow
                    key={entry.id}
                    entry={entry}
                    open={openId === entry.id}
                    onToggle={() => setOpenId(openId === entry.id ? null : entry.id)}
                  />
                ))}
              </ul>
            )}
            <Pager
              total={page.total}
              offset={offset}
              onOffset={(next) => {
                setOffset(next);
                setOpenId(null);
              }}
            />
          </>
        )}
      </Panel>
    </div>
  );
}

function actorLabel(entry: AuditEntry): string {
  switch (entry.actor.kind) {
    case 'admin':
      return 'admin';
    case 'sandbox':
      return `sandbox ${entry.actor.sandbox}`;
    case 'system':
      return 'system';
  }
}

function AuditRow({ entry }: { entry: AuditEntry }): ReactNode {
  const [open, setOpen] = useState(false);
  const detail = JSON.stringify(entry.detail, null, 2);
  return (
    <li className="rounded border border-neutral-200 p-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full flex-wrap items-center gap-3 text-left text-sm"
      >
        <Badge>{entry.action}</Badge>
        <Mono>{entry.target}</Mono>
        <span className="text-neutral-600">{actorLabel(entry)}</span>
        {entry.sandbox === null ? null : <span className="text-neutral-500">{entry.sandbox}</span>}
        <span className="ml-auto text-neutral-500">{formatDateTime(entry.at)}</span>
      </button>
      {open ? <Pre>{detail}</Pre> : null}
    </li>
  );
}

function AuditTab({ scope }: { scope: string | null }): ReactNode {
  const [action, setAction] = useState('');
  const [offset, setOffset] = useState(0);
  const settledAction = useDebounced(action);

  const { state, reload } = useAsync(
    () =>
      observability.listAudit({
        ...(scope === null ? {} : { sandbox: scope }),
        ...(settledAction === '' ? {} : { action: settledAction }),
        limit: PAGE_SIZE,
        offset,
      }),
    [scope, settledAction, offset],
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <input
          className={inputClass}
          placeholder="Action (e.g. sandbox.create)"
          value={action}
          onChange={(event) => {
            setAction(event.target.value);
            setOffset(0);
          }}
        />
        <Button onClick={reload}>Refresh</Button>
      </div>
      <Panel state={state} what="The audit trail">
        {(page) => (
          <>
            {page.results.length === 0 ? (
              <Empty>No audit entries recorded.</Empty>
            ) : (
              <ul className="space-y-2">
                {page.results.map((entry) => (
                  <AuditRow key={entry.id} entry={entry} />
                ))}
              </ul>
            )}
            <Pager total={page.total} offset={offset} onOffset={setOffset} />
          </>
        )}
      </Panel>
    </div>
  );
}

export function HistoryScreen(): ReactNode {
  const [scope, setScope] = useScope();
  const [tab, setTab] = useState<'requests' | 'audit'>('requests');

  return (
    <Section
      title="History"
      actions={
        <span className="flex items-center gap-2">
          <ScopeSelect scope={scope} onChange={setScope} />
          <Button variant={tab === 'requests' ? 'primary' : 'default'} onClick={() => setTab('requests')}>
            Requests
          </Button>
          <Button variant={tab === 'audit' ? 'primary' : 'default'} onClick={() => setTab('audit')}>
            Audit
          </Button>
        </span>
      }
    >
      {/* keyed on the scope so switching sandbox resets filters, paging and the open row */}
      {tab === 'requests' ? (
        <RequestsTab key={scope ?? ''} scope={scope} />
      ) : (
        <AuditTab key={scope ?? ''} scope={scope} />
      )}
    </Section>
  );
}
