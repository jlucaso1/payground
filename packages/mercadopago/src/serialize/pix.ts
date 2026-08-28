import { type Result, type Payment, err, ok } from '@payground/core';
import { type BrCodeError, brCode } from '../pix/index.ts';
import { type QrError, qrPng } from '../qr/index.ts';

export interface PixArtifacts {
  qr_code: string;
  qr_code_base64: string;
  ticket_url: string;
}

export interface PixSettings {
  key: string;
  merchantName: string;
  merchantCity: string;
  baseUrl: string;
}

export type PixError = { kind: 'brcode'; cause: BrCodeError } | { kind: 'qr'; cause: QrError };

/** Deterministic: the same payment always yields the same code, so nothing needs storing. */
export function pixArtifacts(
  payment: Payment,
  sequence: number,
  settings: PixSettings,
): Result<PixArtifacts, PixError> {
  const code = brCode({
    key: settings.key,
    merchantName: settings.merchantName,
    merchantCity: settings.merchantCity,
    amount: payment.amount / 100,
    txid: `PG${sequence}`,
    oneTime: true,
  });
  if (!code.ok) return err({ kind: 'brcode', cause: code.error });

  const png = qrPng(code.value);
  if (!png.ok) return err({ kind: 'qr', cause: png.error });

  return ok({
    qr_code: code.value,
    qr_code_base64: Buffer.from(png.value).toString('base64'),
    ticket_url: `${settings.baseUrl}/payments/${sequence}/ticket`,
  });
}
