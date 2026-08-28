import type { IdempotencyStore } from '@payground/core';
import { type ErrorBody, badRequest, conflict } from '@payground/mercadopago/errors.ts';

/** Mercado Pago rejects a key reused with a different request within 24 hours. */
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export const fingerprint = (method: string, path: string, body: string): string =>
  new Bun.CryptoHasher('sha256').update(`${method} ${path}\n${body}`).digest('hex');

export const missingKey = (): ErrorBody =>
  badRequest('The "X-Idempotency-Key" header is required and was not sent. Make the request again including it.', [
    { code: 4059, description: 'x-idempotency-key is required' },
  ]);

export const reused = (): ErrorBody =>
  conflict(
    'The value sent as the idempotency header has already been used with a different request within the last 24 hours. Please try the request again sending a new value.',
  );

export interface Replay {
  status: number;
  body: string;
}

export type IdempotencyOutcome =
  | { kind: 'proceed' }
  | { kind: 'replay'; replay: Replay }
  | { kind: 'error'; error: ErrorBody };

export function check(
  store: IdempotencyStore,
  key: string | null,
  print: string,
  now: number,
  required: boolean,
): IdempotencyOutcome {
  if (key === null || key === '') {
    return required ? { kind: 'error', error: missingKey() } : { kind: 'proceed' };
  }

  const existing = store.get(key);
  if (existing === null) return { kind: 'proceed' };
  if (now - existing.createdAt >= IDEMPOTENCY_WINDOW_MS) return { kind: 'proceed' };
  if (existing.fingerprint !== print) return { kind: 'error', error: reused() };

  return { kind: 'replay', replay: { status: existing.status, body: existing.body } };
}

export function remember(
  store: IdempotencyStore,
  key: string | null,
  print: string,
  now: number,
  status: number,
  body: string,
): void {
  if (key === null || key === '') return;
  if (status >= 500) return;
  store.purgeBefore(now - IDEMPOTENCY_WINDOW_MS);
  store.put({ key, fingerprint: print, status, body, createdAt: now });
}
