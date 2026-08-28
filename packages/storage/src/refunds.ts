import type { Database } from 'bun:sqlite';
import type { PaymentId, Refund, RefundId, RefundRepository, SandboxId } from '@payground/core';
import { type RefundRow, toRefund } from './rows.ts';

export class SqliteRefundRepository implements RefundRepository {
  constructor(
    private readonly db: Database,
    private readonly sandbox: SandboxId,
  ) {}

  insert(refund: Refund, sequence: number): void {
    this.db
      .query(
        `insert into refunds (sandbox_id, id, sequence, payment_id, amount, status, partial, created_at)
         values ($sandbox_id, $id, $sequence, $payment_id, $amount, $status, $partial, $created_at)`,
      )
      .run({
        $sandbox_id: refund.sandbox,
        $id: refund.id,
        $sequence: sequence,
        $payment_id: refund.paymentId,
        $amount: refund.amount,
        $status: refund.status,
        $partial: refund.partial ? 1 : 0,
        $created_at: refund.createdAt,
      });
  }

  get(id: RefundId): Refund | null {
    const row = this.db
      .query<RefundRow, [string, string]>('select * from refunds where sandbox_id = ? and id = ?')
      .get(this.sandbox, id);
    return row === null ? null : toRefund(row);
  }

  bySequence(sequence: number): Refund | null {
    const row = this.db
      .query<RefundRow, [string, number]>('select * from refunds where sandbox_id = ? and sequence = ?')
      .get(this.sandbox, sequence);
    return row === null ? null : toRefund(row);
  }

  sequenceOf(id: RefundId): number | null {
    const row = this.db
      .query<{ sequence: number }, [string, string]>(
        'select sequence from refunds where sandbox_id = ? and id = ?',
      )
      .get(this.sandbox, id);
    return row === null ? null : row.sequence;
  }

  listFor(paymentId: PaymentId): readonly Refund[] {
    return this.db
      .query<RefundRow, [string, string]>(
        'select * from refunds where sandbox_id = ? and payment_id = ? order by sequence',
      )
      .all(this.sandbox, paymentId)
      .map(toRefund);
  }
}
