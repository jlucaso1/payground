import type { Database } from 'bun:sqlite';
import type {
  Page,
  Payment,
  PaymentId,
  PaymentQuery,
  PaymentRepository,
  SandboxId,
  Transition,
} from '@payground/core';
import { type EventRow, type PaymentRow, toPayment, toStatus } from './rows.ts';

const COLUMNS = `sandbox_id, id, sequence, state, reason, method_kind, method_code, card,
  payer_email, payer_first_name, payer_last_name, payer_document_type, payer_document_number,
  amount, captured_amount, refunded_amount, currency, installments, binary_mode, capture_on_create,
  description, external_reference, notification_url, metadata, created_at, updated_at, settled_at, expires_at`;

type Bindings = Record<string, string | number | null>;

function bind(payment: Payment, sequence: number): Bindings {
  return {
    $sandbox_id: payment.sandbox,
    $id: payment.id,
    $sequence: sequence,
    $state: payment.status.state,
    $reason: payment.status.reason,
    $method_kind: payment.method.kind,
    $method_code: payment.method.code,
    $card: payment.method.card === null ? null : JSON.stringify(payment.method.card),
    $payer_email: payment.payer.email,
    $payer_first_name: payment.payer.firstName,
    $payer_last_name: payment.payer.lastName,
    $payer_document_type: payment.payer.documentType,
    $payer_document_number: payment.payer.documentNumber,
    $amount: payment.amount,
    $captured_amount: payment.capturedAmount,
    $refunded_amount: payment.refundedAmount,
    $currency: payment.currency,
    $installments: payment.installments,
    $binary_mode: payment.binaryMode ? 1 : 0,
    $capture_on_create: payment.captureOnCreate ? 1 : 0,
    $description: payment.description,
    $external_reference: payment.externalReference,
    $notification_url: payment.notificationUrl,
    $metadata: JSON.stringify(payment.metadata),
    $created_at: payment.createdAt,
    $updated_at: payment.updatedAt,
    $settled_at: payment.settledAt,
    $expires_at: payment.expiresAt,
  };
}

export class SqlitePaymentRepository implements PaymentRepository {
  constructor(
    private readonly db: Database,
    private readonly sandbox: SandboxId,
  ) {}

  insert(payment: Payment, sequence: number): void {
    this.db
      .query(
        `insert into payments (${COLUMNS}) values (
          $sandbox_id, $id, $sequence, $state, $reason, $method_kind, $method_code, $card,
          $payer_email, $payer_first_name, $payer_last_name, $payer_document_type, $payer_document_number,
          $amount, $captured_amount, $refunded_amount, $currency, $installments, $binary_mode, $capture_on_create,
          $description, $external_reference, $notification_url, $metadata, $created_at, $updated_at, $settled_at, $expires_at)`,
      )
      .run(bind(payment, sequence));
  }

  update(payment: Payment): void {
    const changed = this.db
      .query(
        `update payments set state = $state, reason = $reason, captured_amount = $captured_amount,
           refunded_amount = $refunded_amount, updated_at = $updated_at, settled_at = $settled_at
         where sandbox_id = $sandbox_id and id = $id`,
      )
      .run({
        $sandbox_id: payment.sandbox,
        $id: payment.id,
        $state: payment.status.state,
        $reason: payment.status.reason,
        $captured_amount: payment.capturedAmount,
        $refunded_amount: payment.refundedAmount,
        $updated_at: payment.updatedAt,
        $settled_at: payment.settledAt,
      });
    if (changed.changes === 0) throw new Error(`payment not found in sandbox: ${payment.id}`);
  }

  get(id: PaymentId): Payment | null {
    const row = this.db
      .query<PaymentRow, [string, string]>('select * from payments where sandbox_id = ? and id = ?')
      .get(this.sandbox, id);
    return row === null ? null : toPayment(row);
  }

  bySequence(sequence: number): Payment | null {
    const row = this.db
      .query<PaymentRow, [string, number]>('select * from payments where sandbox_id = ? and sequence = ?')
      .get(this.sandbox, sequence);
    return row === null ? null : toPayment(row);
  }

  sequenceOf(id: PaymentId): number | null {
    const row = this.db
      .query<{ sequence: number }, [string, string]>(
        'select sequence from payments where sandbox_id = ? and id = ?',
      )
      .get(this.sandbox, id);
    return row === null ? null : row.sequence;
  }

  search(query: PaymentQuery): Page<Payment> {
    const where: string[] = ['sandbox_id = $sandbox_id'];
    const params: Bindings = { $sandbox_id: this.sandbox };

    if (query.states !== undefined && query.states.length > 0) {
      const names = query.states.map((state, i) => {
        params[`$state${i}`] = state;
        return `$state${i}`;
      });
      where.push(`state in (${names.join(', ')})`);
    }
    if (query.methodCode !== undefined) {
      where.push('method_code = $method_code');
      params['$method_code'] = query.methodCode;
    }
    if (query.externalReference !== undefined) {
      where.push('external_reference = $external_reference');
      params['$external_reference'] = query.externalReference;
    }
    if (query.payerEmail !== undefined) {
      where.push('payer_email = $payer_email');
      params['$payer_email'] = query.payerEmail;
    }
    if (query.createdFrom !== undefined) {
      where.push('created_at >= $created_from');
      params['$created_from'] = query.createdFrom;
    }
    if (query.createdTo !== undefined) {
      where.push('created_at <= $created_to');
      params['$created_to'] = query.createdTo;
    }
    if (query.expiredBy !== undefined) {
      where.push("expires_at is not null and expires_at <= $expired_by and state = 'pending'");
      params['$expired_by'] = query.expiredBy;
    }

    const clause = where.join(' and ');
    const total = this.db
      .query<{ n: number }, Bindings>(`select count(*) as n from payments where ${clause}`)
      .get(params);

    const limit = Math.min(Math.max(query.limit ?? 30, 1), 1000);
    const offset = Math.max(query.offset ?? 0, 0);
    const order = query.order === 'asc' ? 'asc' : 'desc';

    const rows = this.db
      .query<PaymentRow, Bindings>(
        `select * from payments where ${clause} order by created_at ${order}, sequence ${order}
         limit $limit offset $offset`,
      )
      .all({ ...params, $limit: limit, $offset: offset });

    return { total: total?.n ?? 0, limit, offset, results: rows.map(toPayment) };
  }

  record(transition: Transition): void {
    this.db
      .query(
        `insert into payment_events (sandbox_id, payment_id, seq, at, command, from_state, from_reason, to_state, to_reason)
         values ($sandbox_id, $payment_id,
           (select coalesce(max(seq), 0) + 1 from payment_events where sandbox_id = $sandbox_id and payment_id = $payment_id),
           $at, $command, $from_state, $from_reason, $to_state, $to_reason)`,
      )
      .run({
        $sandbox_id: transition.payment.sandbox,
        $payment_id: transition.payment.id,
        $at: transition.at,
        $command: JSON.stringify(transition.command),
        $from_state: transition.from.state,
        $from_reason: transition.from.reason,
        $to_state: transition.to.state,
        $to_reason: transition.to.reason,
      });
  }

  timeline(id: PaymentId): readonly Transition[] {
    const payment = this.get(id);
    if (payment === null) return [];
    const rows = this.db
      .query<EventRow, [string, string]>(
        'select seq, at, command, from_state, from_reason, to_state, to_reason from payment_events where sandbox_id = ? and payment_id = ? order by seq',
      )
      .all(this.sandbox, id);

    return rows.map((row) => ({
      payment,
      at: row.at,
      command: JSON.parse(row.command) as Transition['command'],
      from: toStatus(row.from_state, row.from_reason),
      to: toStatus(row.to_state, row.to_reason),
    }));
  }
}
