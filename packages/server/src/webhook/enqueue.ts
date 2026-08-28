import {
  type IdGenerator,
  type Sandbox,
  type SandboxStore,
  type WebhookDelivery,
  webhookDeliveryId,
} from '@payground/core';
import type { EventNotice } from '@payground/mercadopago/api/context.ts';
import { deliveryHeaders, notification } from '@payground/mercadopago/webhook/index.ts';

export interface EnqueueOptions {
  store: SandboxStore;
  sandbox: Sandbox;
  ids: IdGenerator;
  notice: EventNotice;
  now: number;
  collectorId: number;
}

/** Builds the signed request once; retries replay exactly the same bytes, as the real API does. */
export function enqueue(options: EnqueueOptions): WebhookDelivery | null {
  const { store, sandbox, ids, notice, now } = options;
  if (notice.notificationUrl === null || notice.notificationUrl === '') return null;

  const sequence = store.nextSequence('webhook');
  const body = notification({
    id: sequence,
    type: notice.type === 'orders' ? 'payment' : notice.type,
    action: notice.action,
    dataId: notice.dataId,
    userId: options.collectorId,
    liveMode: sandbox.liveMode,
    createdAt: now,
  });

  const requestId = ids.uuid();
  const headers = deliveryHeaders({
    requestId,
    ts: Math.floor(now / 1000),
    dataId: notice.dataId,
    secret: sandbox.webhookSecret,
  });

  const delivery: WebhookDelivery = {
    id: webhookDeliveryId(ids.uuid()),
    sandbox: sandbox.id,
    sequence,
    event: notice.action,
    resourceType: notice.type,
    resourceId: notice.dataId,
    url: notice.notificationUrl,
    status: 'queued',
    attempts: 0,
    requestHeaders: headers,
    requestBody: JSON.stringify(body),
    lastStatusCode: null,
    lastError: null,
    responseBody: null,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  };

  store.webhooks.insert(delivery);
  return delivery;
}
