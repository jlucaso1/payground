import { useMemo, useState, type ReactNode } from 'react';
import type { ApiResult } from '../api/client.ts';
import {
  isUnavailable,
  type DocumentPage,
  type DocumentQuery,
  type StoredDocument,
} from '../api/client-documents.ts';
import { documentsApi } from '../api/instance-documents.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { documentAmounts, firstPopulatedKind, groupKinds, kindLabel } from '../lib/documents.ts';
import { formatDateTime } from '../lib/format.ts';
import { highlightJson, prettyPrint, type JsonTokenType } from '../lib/highlight.ts';
import { Badge, Button, Empty, ErrorBox, Loading, Mono, Section, inputClass } from './ui.tsx';

const PAGE_SIZE = 25;

const EMPTY_PAGE: DocumentPage = { total: 0, limit: PAGE_SIZE, offset: 0, results: [] };

const TOKEN_CLASS: Record<JsonTokenType, string> = {
  key: 'text-neutral-900',
  string: 'text-emerald-700',
  number: 'text-blue-700',
  literal: 'text-purple-700',
  punctuation: 'text-neutral-400',
  plain: 'text-neutral-700',
};

function JsonView({ value }: { value: unknown }): ReactNode {
  const tokens = useMemo(() => highlightJson(prettyPrint(value)), [value]);
  return (
    <pre className="max-h-[32rem] overflow-auto rounded border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs whitespace-pre-wrap">
      {tokens.map((token, index) => (
        <span key={index} className={TOKEN_CLASS[token.type]}>
          {token.text}
        </span>
      ))}
    </pre>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex gap-3 border-b border-neutral-100 py-1.5 text-sm">
      <span className="w-56 shrink-0 break-all text-neutral-500">{label}</span>
      <span className="min-w-0 break-all text-neutral-900">{children}</span>
    </div>
  );
}

function DocumentDetail({
  sandboxId,
  kind,
  docId,
  onClose,
}: {
  sandboxId: string;
  kind: string;
  docId: string;
  onClose: () => void;
}): ReactNode {
  const { state, reload } = useAsync(
    () => documentsApi.getDocument(sandboxId, kind, docId),
    [sandboxId, kind, docId],
  );

  return (
    <Section
      title={`${kindLabel(kind)} ${docId}`}
      actions={
        <span className="flex gap-2">
          <Button onClick={reload}>Refresh</Button>
          <Button onClick={onClose}>Close</Button>
        </span>
      }
    >
      {state.status === 'loading' ? <Loading /> : null}
      {state.status === 'error' ? <ErrorBox error={state.error} /> : null}
      {state.status === 'ready' ? <DocumentBody record={state.value} /> : null}
    </Section>
  );
}

function DocumentBody({ record }: { record: StoredDocument }): ReactNode {
  const amounts = useMemo(() => documentAmounts(record.doc), [record.doc]);
  return (
    <>
      <Row label="Status">
        <Badge>{record.status}</Badge>
      </Row>
      <Row label="External reference">{record.externalReference ?? '—'}</Row>
      <Row label="Lookup">{record.lookup ?? '—'}</Row>
      <Row label="Sequence">{record.sequence}</Row>
      <Row label="Created">{formatDateTime(record.createdAt)}</Row>
      <Row label="Updated">{formatDateTime(record.updatedAt)}</Row>
      <Row label="Expires">
        {record.expiresAt === null ? '—' : formatDateTime(record.expiresAt)}
      </Row>
      {amounts.map((amount) => (
        <Row key={amount.path} label={amount.path}>
          {amount.text}
        </Row>
      ))}
      <div className="mt-4">
        <JsonView value={record.doc} />
      </div>
    </>
  );
}

export function ResourcesScreen({ sandboxId }: { sandboxId: string }): ReactNode {
  const [kind, setKind] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [externalReference, setExternalReference] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [owner, setOwner] = useState(sandboxId);

  if (owner !== sandboxId) {
    setOwner(sandboxId);
    setKind(null);
    setStatus('');
    setExternalReference('');
    setSearch('');
    setOffset(0);
    setSelected(null);
  }

  const kinds = useAsync(() => documentsApi.listKinds(sandboxId), [sandboxId]);
  const entries = kinds.state.status === 'ready' ? groupKinds(kinds.state.value) : [];
  const activeKind = kind ?? firstPopulatedKind(entries);

  const query: DocumentQuery = {
    ...(activeKind === null ? {} : { kind: activeKind }),
    ...(status === '' ? {} : { status }),
    ...(externalReference === '' ? {} : { external_reference: externalReference }),
    ...(search === '' ? {} : { q: search }),
    limit: PAGE_SIZE,
    offset,
  };

  const list = useAsync<DocumentPage>(
    (): Promise<ApiResult<DocumentPage>> =>
      activeKind === null
        ? Promise.resolve({ ok: true, value: EMPTY_PAGE })
        : documentsApi.listDocuments(sandboxId, query),
    [sandboxId, activeKind, status, externalReference, search, offset],
  );

  const pick = (next: string): void => {
    setKind(next);
    setStatus('');
    setExternalReference('');
    setSearch('');
    setOffset(0);
    setSelected(null);
  };

  const setFilter = (apply: (value: string) => void, value: string): void => {
    apply(value);
    setOffset(0);
    setSelected(null);
  };

  if (kinds.state.status === 'error') {
    return (
      <Section title="Resources">
        {isUnavailable(kinds.state.error) ? (
          <Empty>
            Document inspection is not available on this instance. It needs the control API
            endpoint <Mono>GET /_payground/sandboxes/:id/documents</Mono>.
          </Empty>
        ) : (
          <ErrorBox error={kinds.state.error} />
        )}
      </Section>
    );
  }

  return (
    <Section
      title="Resources"
      actions={
        <Button
          onClick={() => {
            kinds.reload();
            list.reload();
          }}
        >
          Refresh
        </Button>
      }
    >
      {kinds.state.status === 'loading' ? <Loading /> : null}
      <div className="flex flex-wrap items-start gap-6">
        <nav className="w-56 shrink-0">
          <ul className="text-sm">
            {entries.map((entry) => (
              <li key={entry.kind}>
                <button
                  type="button"
                  disabled={entry.count === 0}
                  onClick={() => pick(entry.kind)}
                  className={`flex w-full items-center justify-between rounded px-2 py-1 text-left disabled:cursor-not-allowed disabled:text-neutral-400 ${
                    entry.kind === activeKind ? 'bg-neutral-200 text-neutral-900' : 'hover:bg-neutral-100'
                  }`}
                >
                  <span>{entry.label}</span>
                  <span className="text-xs text-neutral-500">{entry.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1">
          {activeKind === null ? (
            kinds.state.status === 'ready' ? <Empty>This sandbox has no documents yet.</Empty> : null
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-end gap-2">
                <input
                  className={inputClass}
                  placeholder="Status"
                  value={status}
                  onChange={(event) => setFilter(setStatus, event.target.value)}
                />
                <input
                  className={inputClass}
                  placeholder="External reference"
                  value={externalReference}
                  onChange={(event) => setFilter(setExternalReference, event.target.value)}
                />
                <input
                  className={inputClass}
                  placeholder="Search"
                  value={search}
                  onChange={(event) => setFilter(setSearch, event.target.value)}
                />
              </div>

              {list.state.status === 'loading' ? <Loading /> : null}
              {list.state.status === 'error' ? <ErrorBox error={list.state.error} /> : null}
              {list.state.status === 'ready' ? (
                <>
                  {list.state.value.results.length === 0 ? (
                    <Empty>No documents match these filters.</Empty>
                  ) : (
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-neutral-300 text-left text-xs text-neutral-500 uppercase">
                          <th className="py-2 pr-4 font-medium">Id</th>
                          <th className="py-2 pr-4 font-medium">Status</th>
                          <th className="py-2 pr-4 font-medium">External reference</th>
                          <th className="py-2 pr-4 font-medium">Created</th>
                          <th className="py-2 pr-4 font-medium">Updated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.state.value.results.map((record) => (
                          <tr
                            key={record.id}
                            className={`cursor-pointer border-b border-neutral-200 hover:bg-neutral-50 ${
                              record.id === selected ? 'bg-neutral-100' : ''
                            }`}
                            onClick={() => setSelected(record.id)}
                          >
                            <td className="py-2 pr-4">
                              <Mono>{record.id}</Mono>
                            </td>
                            <td className="py-2 pr-4">
                              <Badge>{record.status}</Badge>
                            </td>
                            <td className="py-2 pr-4 text-neutral-700">
                              {record.externalReference ?? '—'}
                            </td>
                            <td className="py-2 pr-4 text-neutral-500">
                              {formatDateTime(record.createdAt)}
                            </td>
                            <td className="py-2 pr-4 text-neutral-500">
                              {formatDateTime(record.updatedAt)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div className="mt-4 flex items-center gap-3 text-sm text-neutral-600">
                    <Button
                      disabled={offset === 0}
                      onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                    >
                      Previous
                    </Button>
                    <Button
                      disabled={offset + PAGE_SIZE >= list.state.value.total}
                      onClick={() => setOffset(offset + PAGE_SIZE)}
                    >
                      Next
                    </Button>
                    <span>
                      {Math.min(offset + 1, list.state.value.total)}–
                      {Math.min(offset + list.state.value.results.length, list.state.value.total)} of{' '}
                      {list.state.value.total}
                    </span>
                  </div>
                </>
              ) : null}

              {selected === null ? null : (
                <div className="mt-8">
                  <DocumentDetail
                    sandboxId={sandboxId}
                    kind={activeKind}
                    docId={selected}
                    onClose={() => setSelected(null)}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Section>
  );
}
