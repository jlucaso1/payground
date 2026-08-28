import type { Clock, IdGenerator, Sandbox, SandboxStore } from '@payground/core';

export interface EventNotice {
  type: 'payment';
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
