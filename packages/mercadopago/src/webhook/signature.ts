import { createHmac } from 'node:crypto';

export interface SignatureInput {
  dataId: string | null;
  requestId: string | null;
  ts: number;
  secret: string;
}

// The official validator (mercadopago@3.6.0 src/utils/webhook) trims header/query values and
// treats blank ones as absent, so a blank component must be omitted here too or the manifests
// would diverge.
function present(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function manifest(input: Omit<SignatureInput, 'secret'>): string {
  const parts: string[] = [];
  const dataId = present(input.dataId);
  const requestId = present(input.requestId);
  // https://www.mercadopago.com.br/developers/en/docs/your-integrations/notifications/webhooks
  // documents lowercasing data.id before building the template; the SDK validator does not
  // lowercase, so integrators only agree with us on already-lowercase ids (all ids we mint are).
  if (dataId !== null) parts.push(`id:${dataId.toLowerCase()}`);
  if (requestId !== null) parts.push(`request-id:${requestId}`);
  parts.push(`ts:${input.ts}`);
  return `${parts.join(';')};`;
}

export function sign(input: SignatureInput): string {
  const { secret, ...rest } = input;
  return createHmac('sha256', secret).update(manifest(rest)).digest('hex');
}

export function signatureHeader(input: SignatureInput): string {
  return `ts=${input.ts},v1=${sign(input)}`;
}
