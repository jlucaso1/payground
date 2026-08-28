import { useState, type ReactNode } from 'react';
import type { ApiError } from '../api/client.ts';
import { api } from '../api/instance.ts';
import type { PaymentAction, PaymentActionType, PaymentView } from '../api/types.ts';
import { useAsync } from '../hooks/useAsync.ts';
import {
  ACTION_LABELS,
  actionPermissions,
  capturableAmount,
  refundableAmount,
} from '../lib/actions.ts';
import { formatAmount, formatDateTime, parseAmount } from '../lib/format.ts';
import { Badge, Button, ErrorBox, Loading, Mono, Section, inputClass } from './ui.tsx';

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex gap-3 border-b border-neutral-100 py-1.5 text-sm">
      <span className="w-44 shrink-0 text-neutral-500">{label}</span>
      <span className="text-neutral-900">{children}</span>
    </div>
  );
}

function ActionsPanel({
  payment,
  onApply,
  busy,
}: {
  payment: PaymentView;
  onApply: (action: PaymentAction) => void;
  busy: boolean;
}): ReactNode {
  const [declineReason, setDeclineReason] = useState('cc_rejected_other_reason');
  const [cancelBy, setCancelBy] = useState<'collector' | 'payer'>('collector');
  const [outcome, setOutcome] = useState<'chargeback' | 'merchant'>('merchant');
  const [captureInput, setCaptureInput] = useState('');
  const [refundInput, setRefundInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);

  const permissions = new Map(actionPermissions(payment).map((p) => [p.type, p]));

  const build = (type: PaymentActionType): PaymentAction | null => {
    switch (type) {
      case 'settle':
        return { type: 'settle' };
      case 'expire':
        return { type: 'expire' };
      case 'dispute':
        return { type: 'dispute' };
      case 'decline': {
        if (declineReason.trim() === '') {
          setInputError('A decline reason is required.');
          return null;
        }
        return { type: 'decline', reason: declineReason.trim() };
      }
      case 'cancel':
        return { type: 'cancel', by: cancelBy };
      case 'resolve':
        return { type: 'resolve', outcome };
      case 'capture': {
        if (captureInput.trim() === '') return { type: 'capture', amount: null };
        const amount = parseAmount(captureInput, payment.currency);
        if (amount === null || amount <= 0 || amount > capturableAmount(payment)) {
          setInputError('Capture amount must be positive and at most the capturable amount.');
          return null;
        }
        return { type: 'capture', amount };
      }
      case 'refund': {
        const amount = parseAmount(refundInput, payment.currency);
        if (amount === null || amount <= 0 || amount > refundableAmount(payment)) {
          setInputError('Refund amount must be positive and at most the refundable amount.');
          return null;
        }
        return { type: 'refund', amount };
      }
    }
  };

  const trigger = (type: PaymentActionType): void => {
    setInputError(null);
    const action = build(type);
    if (action !== null) onApply(action);
  };

  const renderRow = (type: PaymentActionType, extra?: ReactNode): ReactNode => {
    const permission = permissions.get(type);
    const allowed = permission?.allowed === true;
    const reason = permission?.reason ?? null;
    return (
      <div key={type} className="flex flex-wrap items-center gap-2 border-b border-neutral-100 py-2">
        <div className="w-40 shrink-0">
          <Button
            variant={allowed ? 'primary' : 'default'}
            disabled={!allowed || busy}
            title={reason ?? undefined}
            onClick={() => trigger(type)}
          >
            {ACTION_LABELS[type]}
          </Button>
        </div>
        {allowed ? extra : <span className="text-xs text-neutral-500">{reason}</span>}
      </div>
    );
  };

  return (
    <div>
      {inputError === null ? null : <p className="mb-2 text-sm text-red-700">{inputError}</p>}
      {renderRow('settle')}
      {renderRow(
        'decline',
        <input
          className={inputClass}
          value={declineReason}
          placeholder="Reason"
          onChange={(event) => setDeclineReason(event.target.value)}
        />,
      )}
      {renderRow('expire')}
      {renderRow(
        'cancel',
        <select
          className={inputClass}
          value={cancelBy}
          onChange={(event) => setCancelBy(event.target.value === 'payer' ? 'payer' : 'collector')}
        >
          <option value="collector">by collector</option>
          <option value="payer">by payer</option>
        </select>,
      )}
      {renderRow(
        'capture',
        <span className="flex items-center gap-2">
          <input
            className={inputClass}
            value={captureInput}
            placeholder={`full (${formatAmount(capturableAmount(payment), payment.currency)})`}
            onChange={(event) => setCaptureInput(event.target.value)}
          />
          <span className="text-xs text-neutral-500">leave empty to capture in full</span>
        </span>,
      )}
      {renderRow(
        'refund',
        <span className="flex items-center gap-2">
          <input
            className={inputClass}
            value={refundInput}
            placeholder="Amount"
            onChange={(event) => setRefundInput(event.target.value)}
          />
          <span className="text-xs text-neutral-500">
            up to {formatAmount(refundableAmount(payment), payment.currency)}
          </span>
        </span>,
      )}
      {renderRow('dispute')}
      {renderRow(
        'resolve',
        <select
          className={inputClass}
          value={outcome}
          onChange={(event) =>
            setOutcome(event.target.value === 'chargeback' ? 'chargeback' : 'merchant')
          }
        >
          <option value="merchant">merchant wins</option>
          <option value="chargeback">chargeback</option>
        </select>,
      )}
    </div>
  );
}

export function PaymentDetailScreen({
  sandboxId,
  paymentId,
}: {
  sandboxId: string;
  paymentId: string;
}): ReactNode {
  const { state, reload } = useAsync(
    () => api.getPayment(sandboxId, paymentId),
    [sandboxId, paymentId],
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  const apply = (action: PaymentAction): void => {
    setBusy(true);
    setActionError(null);
    void api.applyAction(sandboxId, paymentId, action).then((result) => {
      setBusy(false);
      if (!result.ok) setActionError(result.error);
      reload();
    });
  };

  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') return <ErrorBox error={state.error} />;

  const { payment, timeline, refunds } = state.value;

  return (
    <>
      <Section title={`Payment ${payment.id}`} actions={<Button onClick={reload}>Refresh</Button>}>
        <Row label="State">
          <Badge>{payment.state}</Badge> <span className="text-neutral-500">{payment.reason}</span>
        </Row>
        <Row label="Mercado Pago status">
          {payment.providerStatus} / {payment.providerStatusDetail}
        </Row>
        <Row label="Method">
          {payment.methodKind} / {payment.methodCode}
        </Row>
        <Row label="Amount">{formatAmount(payment.amount, payment.currency)}</Row>
        <Row label="Captured">{formatAmount(payment.capturedAmount, payment.currency)}</Row>
        <Row label="Refunded">{formatAmount(payment.refundedAmount, payment.currency)}</Row>
        <Row label="Payer">{payment.payerEmail}</Row>
        <Row label="Description">{payment.description ?? '—'}</Row>
        <Row label="External reference">{payment.externalReference ?? '—'}</Row>
        <Row label="Sequence">{payment.sequence}</Row>
        <Row label="Created">{formatDateTime(payment.createdAt)}</Row>
        <Row label="Updated">{formatDateTime(payment.updatedAt)}</Row>
        <Row label="Expires">
          {payment.expiresAt === null ? '—' : formatDateTime(payment.expiresAt)}
        </Row>
      </Section>

      <Section title="Actions">
        {actionError === null ? null : (
          <div className="mb-3">
            <ErrorBox error={actionError} />
          </div>
        )}
        <ActionsPanel payment={payment} onApply={apply} busy={busy} />
      </Section>

      <Section title="Refunds">
        {refunds.length === 0 ? (
          <p className="text-sm text-neutral-500">No refunds.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-300 text-left text-xs text-neutral-500 uppercase">
                <th className="py-2 pr-4 font-medium">Id</th>
                <th className="py-2 pr-4 font-medium">Amount</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Partial</th>
                <th className="py-2 pr-4 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {refunds.map((refund) => (
                <tr key={refund.id} className="border-b border-neutral-200">
                  <td className="py-2 pr-4">
                    <Mono>{refund.id}</Mono>
                  </td>
                  <td className="py-2 pr-4">{formatAmount(refund.amount, payment.currency)}</td>
                  <td className="py-2 pr-4">{refund.status}</td>
                  <td className="py-2 pr-4">{refund.partial ? 'yes' : 'no'}</td>
                  <td className="py-2 pr-4 text-neutral-500">{formatDateTime(refund.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Timeline">
        {timeline.length === 0 ? (
          <p className="text-sm text-neutral-500">No transitions.</p>
        ) : (
          <ol className="space-y-2">
            {timeline.map((entry, index) => (
              <li
                key={`${entry.at}-${index}`}
                className="rounded border border-neutral-200 p-2 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-neutral-500">{formatDateTime(entry.at)}</span>
                  <Badge>{entry.command.type}</Badge>
                  <span className="text-neutral-700">
                    {entry.from.state} → {entry.to.state}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {entry.from.reason} → {entry.to.reason}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </>
  );
}
