import type { PaymentActionType, PaymentState, PaymentView } from '../api/types.ts';

export const PAYMENT_ACTION_TYPES: readonly PaymentActionType[] = [
  'settle',
  'decline',
  'expire',
  'cancel',
  'capture',
  'refund',
  'dispute',
  'resolve',
];

export const ACTION_LABELS: Record<PaymentActionType, string> = {
  settle: 'Approve',
  decline: 'Decline',
  expire: 'Expire',
  cancel: 'Cancel',
  capture: 'Capture',
  refund: 'Refund',
  dispute: 'Open dispute',
  resolve: 'Resolve dispute',
};

const ALLOWED_STATES: Record<PaymentActionType, readonly PaymentState[]> = {
  settle: ['pending', 'in_review'],
  decline: ['pending', 'authorized', 'in_review'],
  expire: ['pending'],
  cancel: ['pending', 'authorized', 'in_review'],
  capture: ['authorized'],
  refund: ['succeeded'],
  dispute: ['succeeded'],
  resolve: ['in_mediation'],
};

export interface ActionPermission {
  type: PaymentActionType;
  allowed: boolean;
  reason: string | null;
}

export function refundableAmount(payment: Pick<PaymentView, 'capturedAmount' | 'refundedAmount'>): number {
  return Math.max(0, payment.capturedAmount - payment.refundedAmount);
}

export function capturableAmount(payment: Pick<PaymentView, 'amount' | 'capturedAmount'>): number {
  return Math.max(0, payment.amount - payment.capturedAmount);
}

export function actionPermission(
  type: PaymentActionType,
  payment: Pick<PaymentView, 'state' | 'amount' | 'capturedAmount' | 'refundedAmount'>,
): ActionPermission {
  const states = ALLOWED_STATES[type];
  if (!states.includes(payment.state)) {
    return {
      type,
      allowed: false,
      reason: `Not allowed while the payment is ${payment.state}; allowed in: ${states.join(', ')}`,
    };
  }

  if (type === 'refund' && refundableAmount(payment) === 0) {
    return { type, allowed: false, reason: 'Nothing left to refund' };
  }

  if (type === 'capture' && capturableAmount(payment) === 0) {
    return { type, allowed: false, reason: 'Already fully captured' };
  }

  return { type, allowed: true, reason: null };
}

export function actionPermissions(
  payment: Pick<PaymentView, 'state' | 'amount' | 'capturedAmount' | 'refundedAmount'>,
): ActionPermission[] {
  return PAYMENT_ACTION_TYPES.map((type) => actionPermission(type, payment));
}
