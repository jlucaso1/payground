import type { PaymentId, RefundId, SandboxId } from '../ids.ts';
import type { Minor } from '../money.ts';

export type RefundStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface Refund {
  readonly id: RefundId;
  readonly sandbox: SandboxId;
  readonly paymentId: PaymentId;
  readonly amount: Minor;
  readonly status: RefundStatus;
  readonly partial: boolean;
  readonly createdAt: number;
}

const ALLOWED: Record<RefundStatus, readonly RefundStatus[]> = {
  pending: ['approved', 'rejected', 'cancelled'],
  approved: [],
  rejected: [],
  cancelled: [],
};

export const canTransition = (from: RefundStatus, to: RefundStatus): boolean =>
  ALLOWED[from].includes(to);
