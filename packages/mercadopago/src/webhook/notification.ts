import { signatureHeader } from './signature.ts';

export type NotificationType =
  | 'payment'
  | 'merchant_order'
  | 'subscription_preapproval'
  | 'subscription_preapproval_plan'
  | 'subscription_authorized_payment';

export interface NotificationInput {
  id: number;
  type: NotificationType;
  action: string;
  dataId: string;
  userId: number;
  liveMode: boolean;
  createdAt: number;
}

export interface Notification {
  id: number;
  live_mode: boolean;
  type: string;
  date_created: string;
  user_id: number;
  api_version: string;
  action: string;
  data: { id: string };
}

export interface DeliveryHeaders {
  [name: string]: string;
}

// Notifications carry dates in the account timezone, rendered as a fixed -04:00 offset in
// https://www.mercadopago.com.br/developers/en/docs/your-integrations/notifications/webhooks
const OFFSET_MINUTES = -4 * 60;
const OFFSET_LABEL = '-04:00';

// Not documented by Mercado Pago; this is the value observed on real deliveries.
const USER_AGENT = 'MercadoPago WebHook v1.0 payment';

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function dateCreated(epochMs: number): string {
  const shifted = new Date(epochMs + OFFSET_MINUTES * 60_000);
  const date = `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1, 2)}-${pad(shifted.getUTCDate(), 2)}`;
  const time = `${pad(shifted.getUTCHours(), 2)}:${pad(shifted.getUTCMinutes(), 2)}:${pad(shifted.getUTCSeconds(), 2)}.${pad(shifted.getUTCMilliseconds(), 3)}`;
  return `${date}T${time}${OFFSET_LABEL}`;
}

export function notification(input: NotificationInput): Notification {
  return {
    id: input.id,
    live_mode: input.liveMode,
    type: input.type,
    date_created: dateCreated(input.createdAt),
    user_id: input.userId,
    api_version: 'v1',
    action: input.action,
    data: { id: input.dataId },
  };
}

export function deliveryHeaders(input: {
  requestId: string;
  ts: number;
  dataId: string;
  secret: string;
}): DeliveryHeaders {
  return {
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    'x-request-id': input.requestId,
    'x-signature': signatureHeader({
      dataId: input.dataId,
      requestId: input.requestId,
      ts: input.ts,
      secret: input.secret,
    }),
  };
}
