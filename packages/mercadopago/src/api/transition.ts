import type { Transition } from '@payground/core';
import type { ServiceContext } from './context.ts';

/** Persists a payment transition and publishes the notification it produces. */
export function commit(context: ServiceContext, transition: Transition): void {
  context.store.payments.update(transition.payment);
  context.store.payments.record(transition);
  const sequence = context.store.payments.sequenceOf(transition.payment.id);
  if (sequence === null) return;
  context.events.emit({
    type: 'payment',
    action: 'payment.updated',
    dataId: String(sequence),
    notificationUrl: transition.payment.notificationUrl,
  });
}
