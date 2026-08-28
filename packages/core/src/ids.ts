declare const brand: unique symbol;

type Branded<Tag extends string> = string & { readonly [brand]: Tag };

export type SandboxId = Branded<'SandboxId'>;
export type PaymentId = Branded<'PaymentId'>;
export type RefundId = Branded<'RefundId'>;
export type CustomerId = Branded<'CustomerId'>;
export type CardTokenId = Branded<'CardTokenId'>;
export type CheckoutSessionId = Branded<'CheckoutSessionId'>;
export type OrderId = Branded<'OrderId'>;
export type WebhookDeliveryId = Branded<'WebhookDeliveryId'>;

const make = <T extends string>(value: string): Branded<T> => value as Branded<T>;

export const sandboxId = (value: string): SandboxId => make<'SandboxId'>(value);
export const paymentId = (value: string): PaymentId => make<'PaymentId'>(value);
export const refundId = (value: string): RefundId => make<'RefundId'>(value);
export const customerId = (value: string): CustomerId => make<'CustomerId'>(value);
export const cardTokenId = (value: string): CardTokenId => make<'CardTokenId'>(value);
export const checkoutSessionId = (value: string): CheckoutSessionId => make<'CheckoutSessionId'>(value);
export const orderId = (value: string): OrderId => make<'OrderId'>(value);
export const webhookDeliveryId = (value: string): WebhookDeliveryId => make<'WebhookDeliveryId'>(value);
