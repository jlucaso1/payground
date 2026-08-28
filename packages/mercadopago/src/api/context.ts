import type { Clock, IdGenerator, Sandbox, SandboxStore } from '@payground/core';

/** Notification topics the API publishes. */
export type NotificationTopic =
  | 'payment'
  | 'merchant_order'
  | 'orders'
  | 'subscription_preapproval'
  | 'subscription_preapproval_plan'
  | 'subscription_authorized_payment';

export interface EventNotice {
  type: NotificationTopic;
  action: string;
  dataId: string;
  notificationUrl: string | null;
}

export interface EventSink {
  emit(notice: EventNotice): void;
}

export const noopSink: EventSink = { emit: () => undefined };

export interface ServiceContext {
  store: SandboxStore;
  sandbox: Sandbox;
  clock: Clock;
  ids: IdGenerator;
  /** Public origin of this payground instance, used for ticket and checkout URLs. */
  baseUrl: string;
  collectorId: number;
  events: EventSink;
}

export interface Rendered {
  status: number;
  body: unknown;
}
