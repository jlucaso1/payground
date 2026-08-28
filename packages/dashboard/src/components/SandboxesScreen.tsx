import { useState, type ReactNode } from 'react';
import type { ApiResult } from '../api/client.ts';
import { api } from '../api/instance.ts';
import type { Sandbox } from '../api/types.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { formatDateTime } from '../lib/format.ts';
import type { Route } from '../lib/router.ts';
import { Button, CopyButton, Empty, ErrorBox, Loading, Mono, Section, inputClass } from './ui.tsx';

function Credential({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <span className="w-32 shrink-0 text-xs text-neutral-500">{label}</span>
      <Mono>{value}</Mono>
      <CopyButton value={value} />
    </div>
  );
}

export function SandboxesScreen({ navigate }: { navigate: (route: Route) => void }): ReactNode {
  const { state, reload } = useAsync(() => api.listSandboxes(), []);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const run = (op: Promise<ApiResult<unknown>>): void => {
    setBusy(true);
    void op.then((result) => {
      setBusy(false);
      setMessage(result.ok ? null : result.error.message);
      reload();
    });
  };

  return (
    <Section title="Sandboxes">
      <form
        className="mb-4 flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() === '') return;
          run(api.createSandbox(name.trim()));
          setName('');
        }}
      >
        <input
          className={inputClass}
          placeholder="Sandbox name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          type="submit"
          disabled={busy || name.trim() === ''}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40"
        >
          Create
        </button>
      </form>

      {message === null ? null : <p className="mb-3 text-sm text-red-700">{message}</p>}

      {state.status === 'loading' ? <Loading /> : null}
      {state.status === 'error' ? <ErrorBox error={state.error} /> : null}
      {state.status === 'ready' ? (
        state.value.length === 0 ? (
          <Empty>No sandboxes yet.</Empty>
        ) : (
          <ul className="space-y-4">
            {state.value.map((sandbox: Sandbox) => (
              <li key={sandbox.id} className="rounded border border-neutral-200 p-4">
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <span className="font-medium text-neutral-900">{sandbox.name}</span>
                  <Mono>{sandbox.id}</Mono>
                  <span className="text-xs text-neutral-500">
                    {sandbox.liveMode ? 'live' : 'test'} · created {formatDateTime(sandbox.createdAt)}
                  </span>
                </div>
                <div className="mb-3 space-y-1">
                  <Credential label="Access token" value={sandbox.accessToken} />
                  <Credential label="Public key" value={sandbox.publicKey} />
                  <Credential label="Webhook secret" value={sandbox.webhookSecret} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => navigate({ name: 'payments', sandboxId: sandbox.id })}>
                    Payments
                  </Button>
                  <Button onClick={() => navigate({ name: 'webhooks', sandboxId: sandbox.id })}>
                    Webhooks
                  </Button>
                  <Button onClick={() => navigate({ name: 'faults', sandboxId: sandbox.id })}>
                    Faults
                  </Button>
                  <Button disabled={busy} onClick={() => run(api.resetSandbox(sandbox.id))}>
                    Reset
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Delete sandbox "${sandbox.name}"?`)) {
                        run(api.deleteSandbox(sandbox.id));
                      }
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </Section>
  );
}
