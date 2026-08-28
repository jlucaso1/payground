import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/instance.ts';
import type { FaultProfile } from '../api/types.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { Button, ErrorBox, Field, Loading, Section, inputClass } from './ui.tsx';

function clampRate(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(100, Math.max(0, parsed)) / 100;
}

function Form({ initial, sandboxId }: { initial: FaultProfile; sandboxId: string }): ReactNode {
  const [draft, setDraft] = useState<FaultProfile>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setDraft(initial);
  }, [initial]);

  const submit = (): void => {
    setBusy(true);
    setMessage(null);
    void api.setFaults(sandboxId, draft).then((result) => {
      setBusy(false);
      if (result.ok) {
        setDraft(result.value);
        setMessage('Saved.');
      } else {
        setMessage(result.error.message);
      }
    });
  };

  return (
    <form
      className="max-w-md space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Field label="Artificial latency (ms)">
        <input
          className={inputClass}
          type="number"
          min={0}
          value={draft.latencyMs}
          onChange={(event) =>
            setDraft({ ...draft, latencyMs: Math.max(0, Number(event.target.value) || 0) })
          }
        />
      </Field>
      <Field label="API error rate (%)">
        <input
          className={inputClass}
          type="number"
          min={0}
          max={100}
          value={Math.round(draft.errorRate * 1000) / 10}
          onChange={(event) => setDraft({ ...draft, errorRate: clampRate(event.target.value) })}
        />
      </Field>
      <Field label="Webhook failure rate (%)">
        <input
          className={inputClass}
          type="number"
          min={0}
          max={100}
          value={Math.round(draft.webhookFailureRate * 1000) / 10}
          onChange={(event) =>
            setDraft({ ...draft, webhookFailureRate: clampRate(event.target.value) })
          }
        />
      </Field>
      <label className="flex items-center gap-2 text-sm text-neutral-800">
        <input
          type="checkbox"
          checked={draft.unavailable}
          onChange={(event) => setDraft({ ...draft, unavailable: event.target.checked })}
        />
        Unavailable (return 503 for every API call)
      </label>
      <label className="flex items-center gap-2 text-sm text-neutral-800">
        <input
          type="checkbox"
          checked={draft.duplicateWebhooks}
          onChange={(event) => setDraft({ ...draft, duplicateWebhooks: event.target.checked })}
        />
        Deliver every webhook twice
      </label>
      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={busy} onClick={submit}>
          Save
        </Button>
        {message === null ? null : <span className="text-sm text-neutral-600">{message}</span>}
      </div>
    </form>
  );
}

export function FaultsScreen({ sandboxId }: { sandboxId: string }): ReactNode {
  const { state } = useAsync(() => api.getFaults(sandboxId), [sandboxId]);

  return (
    <Section title="Fault injection">
      {state.status === 'loading' ? <Loading /> : null}
      {state.status === 'error' ? <ErrorBox error={state.error} /> : null}
      {state.status === 'ready' ? <Form initial={state.value} sandboxId={sandboxId} /> : null}
    </Section>
  );
}
