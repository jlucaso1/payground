import { useState, type ReactNode } from 'react';
import { api } from '../api/instance.ts';
import type { WebhookDeliveryView } from '../api/types.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { formatDateTime } from '../lib/format.ts';
import { Badge, Button, Empty, ErrorBox, Loading, Mono, Pre, Section, prettyJson } from './ui.tsx';

function Delivery({
  delivery,
  onReplay,
  busy,
}: {
  delivery: WebhookDeliveryView;
  onReplay: () => void;
  busy: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const headers = Object.entries(delivery.requestHeaders)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');

  return (
    <li className="rounded border border-neutral-200 p-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge>{delivery.status}</Badge>
        <span className="font-medium text-neutral-900">{delivery.event}</span>
        <Mono>{delivery.url}</Mono>
        <span className="text-neutral-600">attempts: {delivery.attempts}</span>
        <span className="text-neutral-600">
          code: {delivery.lastStatusCode === null ? '—' : delivery.lastStatusCode}
        </span>
        <span className="text-neutral-500">{formatDateTime(delivery.createdAt)}</span>
        {delivery.nextAttemptAt === null ? null : (
          <span className="text-neutral-500">next: {formatDateTime(delivery.nextAttemptAt)}</span>
        )}
        <span className="ml-auto flex gap-2">
          <Button onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Details'}</Button>
          <Button disabled={busy} onClick={onReplay}>
            Replay
          </Button>
        </span>
      </div>
      {delivery.lastError === null ? null : (
        <p className="mt-2 text-sm text-red-700">{delivery.lastError}</p>
      )}
      {open ? (
        <div className="mt-3 space-y-3">
          {delivery.paymentId === null ? null : (
            <p className="text-xs text-neutral-500">
              payment: <Mono>{delivery.paymentId}</Mono>
            </p>
          )}
          <div>
            <p className="mb-1 text-xs text-neutral-500 uppercase">Request headers</p>
            <Pre>{headers}</Pre>
          </div>
          <div>
            <p className="mb-1 text-xs text-neutral-500 uppercase">Request body</p>
            <Pre>{prettyJson(delivery.requestBody)}</Pre>
          </div>
          <div>
            <p className="mb-1 text-xs text-neutral-500 uppercase">Response body</p>
            <Pre>{delivery.responseBody === null ? '—' : prettyJson(delivery.responseBody)}</Pre>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function WebhooksScreen({ sandboxId }: { sandboxId: string }): ReactNode {
  const { state, reload } = useAsync(() => api.listWebhooks(sandboxId), [sandboxId]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const replay = (id: string): void => {
    setBusy(true);
    setMessage(null);
    void api.replayWebhook(sandboxId, id).then((result) => {
      setBusy(false);
      if (!result.ok) setMessage(result.error.message);
      reload();
    });
  };

  return (
    <Section title="Webhook deliveries" actions={<Button onClick={reload}>Refresh</Button>}>
      {message === null ? null : <p className="mb-3 text-sm text-red-700">{message}</p>}
      {state.status === 'loading' ? <Loading /> : null}
      {state.status === 'error' ? <ErrorBox error={state.error} /> : null}
      {state.status === 'ready' ? (
        state.value.length === 0 ? (
          <Empty>No deliveries recorded.</Empty>
        ) : (
          <ul className="space-y-3">
            {state.value.map((delivery) => (
              <Delivery
                key={delivery.id}
                delivery={delivery}
                busy={busy}
                onReplay={() => replay(delivery.id)}
              />
            ))}
          </ul>
        )
      ) : null}
    </Section>
  );
}
