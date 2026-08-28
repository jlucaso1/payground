import { useState, type ReactNode } from 'react';
import { api } from '../api/instance.ts';
import { PAYMENT_STATES, type PaymentQuery, type PaymentState } from '../api/types.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { formatAmount, formatDateTime } from '../lib/format.ts';
import type { Route } from '../lib/router.ts';
import { Badge, Button, Empty, ErrorBox, Loading, Mono, Section, inputClass } from './ui.tsx';

const PAGE_SIZE = 25;

export function PaymentsScreen({
  sandboxId,
  navigate,
}: {
  sandboxId: string;
  navigate: (route: Route) => void;
}): ReactNode {
  const [stateFilter, setStateFilter] = useState<PaymentState | ''>('');
  const [method, setMethod] = useState('');
  const [externalReference, setExternalReference] = useState('');
  const [offset, setOffset] = useState(0);

  const query: PaymentQuery = {
    ...(stateFilter === '' ? {} : { state: stateFilter }),
    ...(method === '' ? {} : { method }),
    ...(externalReference === '' ? {} : { external_reference: externalReference }),
    limit: PAGE_SIZE,
    offset,
  };

  const { state, reload } = useAsync(
    () => api.listPayments(sandboxId, query),
    [sandboxId, stateFilter, method, externalReference, offset],
  );

  return (
    <Section title="Payments" actions={<Button onClick={reload}>Refresh</Button>}>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <select
          className={inputClass}
          value={stateFilter}
          onChange={(event) => {
            setStateFilter(event.target.value as PaymentState | '');
            setOffset(0);
          }}
        >
          <option value="">All states</option>
          {PAYMENT_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          className={inputClass}
          placeholder="Method (e.g. pix)"
          value={method}
          onChange={(event) => {
            setMethod(event.target.value);
            setOffset(0);
          }}
        />
        <input
          className={inputClass}
          placeholder="External reference"
          value={externalReference}
          onChange={(event) => {
            setExternalReference(event.target.value);
            setOffset(0);
          }}
        />
      </div>

      {state.status === 'loading' ? <Loading /> : null}
      {state.status === 'error' ? <ErrorBox error={state.error} /> : null}
      {state.status === 'ready' ? (
        state.value.results.length === 0 ? (
          <Empty>No payments match these filters.</Empty>
        ) : (
          <>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-300 text-left text-xs text-neutral-500 uppercase">
                  <th className="py-2 pr-4 font-medium">Id</th>
                  <th className="py-2 pr-4 font-medium">Method</th>
                  <th className="py-2 pr-4 font-medium">Amount</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {state.value.results.map((payment) => (
                  <tr
                    key={payment.id}
                    className="cursor-pointer border-b border-neutral-200 hover:bg-neutral-50"
                    onClick={() =>
                      navigate({ name: 'payment', sandboxId, paymentId: payment.id })
                    }
                  >
                    <td className="py-2 pr-4">
                      <Mono>{payment.id}</Mono>
                    </td>
                    <td className="py-2 pr-4 text-neutral-700">
                      {payment.methodKind} / {payment.methodCode}
                    </td>
                    <td className="py-2 pr-4 text-neutral-900">
                      {formatAmount(payment.amount, payment.currency)}
                    </td>
                    <td className="py-2 pr-4">
                      <Badge>{payment.providerStatus}</Badge>{' '}
                      <span className="text-xs text-neutral-500">
                        {payment.providerStatusDetail}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-neutral-500">
                      {formatDateTime(payment.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-4 flex items-center gap-3 text-sm text-neutral-600">
              <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                Previous
              </Button>
              <Button
                disabled={offset + PAGE_SIZE >= state.value.total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
              <span>
                {offset + 1}–{Math.min(offset + state.value.results.length, state.value.total)} of{' '}
                {state.value.total}
              </span>
            </div>
          </>
        )
      ) : null}
    </Section>
  );
}
