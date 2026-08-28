import type { Payment, Result } from '@payground/core';
import { type BoletoError, barcode, linhaDigitavel } from '../boleto/index.ts';

export interface BoletoArtifacts {
  barcode: string;
  line: string;
  ticket_url: string;
}

export interface BoletoSettings {
  bankCode: string;
  baseUrl: string;
}

/** Deterministic, like the Pix code: derived from the payment, never stored. */
export function boletoArtifacts(
  payment: Payment,
  sequence: number,
  settings: BoletoSettings,
): Result<BoletoArtifacts, BoletoError> {
  const code = barcode({
    bankCode: settings.bankCode,
    amount: payment.amount / 100,
    dueDate: payment.expiresAt === null ? null : new Date(payment.expiresAt),
    freeField: String(sequence).padStart(25, '0'),
  });
  if (!code.ok) return code;

  const line = linhaDigitavel(code.value);
  if (!line.ok) return line;

  return {
    ok: true,
    value: {
      barcode: code.value,
      line: line.value,
      ticket_url: `${settings.baseUrl}/payments/${sequence}/ticket`,
    },
  };
}
