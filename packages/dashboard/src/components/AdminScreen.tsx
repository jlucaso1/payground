import { useState, type ReactNode } from 'react';
import type { ApiResult, SandboxDetail } from '../api/client.ts';
import { api } from '../api/instance.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { formatDateTime } from '../lib/format.ts';
import { Button, CopyButton, Empty, ErrorBox, Loading, Mono, Section, inputClass } from './ui.tsx';

const MASK = '••••••••••••';

function Secret({ label, value }: { label: string; value: string }): ReactNode {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="w-32 shrink-0 text-xs text-neutral-500">{label}</span>
      <Mono>{shown ? value : MASK}</Mono>
      <Button onClick={() => setShown(!shown)}>{shown ? 'Hide' : 'Reveal'}</Button>
      <CopyButton value={value} />
    </div>
  );
}

function Confirm({
  label,
  phrase,
  disabled,
  onConfirm,
}: {
  label: string;
  phrase: string;
  disabled: boolean;
  onConfirm: () => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');

  if (!open) {
    return (
      <Button
        variant="danger"
        disabled={disabled}
        onClick={() => {
          setTyped('');
          setOpen(true);
        }}
      >
        {label}
      </Button>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-neutral-600">
        Type <Mono>{phrase}</Mono> to confirm
      </span>
      <input
        className={inputClass}
        value={typed}
        aria-label={`Confirm ${label}`}
        onChange={(event) => setTyped(event.target.value)}
      />
      <Button
        variant="danger"
        disabled={disabled || typed !== phrase}
        onClick={() => {
          setOpen(false);
          onConfirm();
        }}
      >
        {label}
      </Button>
      <Button onClick={() => setOpen(false)}>Cancel</Button>
    </span>
  );
}

function Row({
  sandbox,
  busy,
  run,
}: {
  sandbox: SandboxDetail;
  busy: boolean;
  run: (op: Promise<ApiResult<unknown>>) => void;
}): ReactNode {
  const phrase = sandbox.name === '' ? sandbox.id : sandbox.name;

  return (
    <li className="rounded border border-neutral-200 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="font-medium text-neutral-900">{sandbox.name}</span>
        <Mono>{sandbox.id}</Mono>
        <span className="text-xs text-neutral-500">
          {sandbox.liveMode ? 'live' : 'test'} · created {formatDateTime(sandbox.createdAt)} ·{' '}
          {sandbox.counts === null
            ? 'counts unavailable'
            : `${sandbox.counts.payments} payments · ${sandbox.counts.webhooks}${
                sandbox.counts.webhooks >= 1000 ? '+' : ''
              } webhooks`}
        </span>
      </div>

      <div className="mb-3 space-y-1">
        <Secret label="Access token" value={sandbox.accessToken} />
        <Secret label="Public key" value={sandbox.publicKey} />
        <Secret label="Webhook secret" value={sandbox.webhookSecret} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Confirm
          label="Reset"
          phrase={phrase}
          disabled={busy}
          onConfirm={() => run(api.resetSandbox(sandbox.id))}
        />
        <Confirm
          label="Delete"
          phrase={phrase}
          disabled={busy}
          onConfirm={() => run(api.deleteSandbox(sandbox.id))}
        />
      </div>
    </li>
  );
}

export function AdminScreen(): ReactNode {
  const { state, reload } = useAsync(() => api.listSandboxDetails(), []);
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
    <Section title="Accounts">
      <p className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        Test credentials only. payground emulates Mercado Pago and stores everything in plain text —
        never send real card numbers, real personal data or production tokens to this server.
      </p>

      <p className="mb-4 text-xs text-neutral-500">
        Renaming a sandbox needs <Mono>PUT /_payground/sandboxes/:id</Mono>, which the control API
        does not expose yet.
      </p>

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
          aria-label="New sandbox name"
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
            {state.value.map((sandbox) => (
              <Row key={sandbox.id} sandbox={sandbox} busy={busy} run={run} />
            ))}
          </ul>
        )
      ) : null}
    </Section>
  );
}
