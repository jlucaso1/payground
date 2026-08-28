import { type Result, err, ok, toDecimal } from '@payground/core';
import { ticketHtml } from '../boleto/ticket.ts';
import { escapeHtml } from '../checkout/html.ts';
import { type ErrorBody, notFound } from '../errors.ts';
import { boletoArtifacts } from '../serialize/boleto.ts';
import { pixArtifacts } from '../serialize/pix.ts';
import type { ServiceContext } from './context.ts';
import { materialize } from './payments.ts';

const BOLETO_BANKS: Record<string, string> = { bolbradesco: '237', bolbradesco_pec: '237', pec: '237' };

const pixTicket = (code: string, png: string, amount: number, reference: string): string =>
  '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Pix</title>' +
  '<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:32rem}' +
  'code{display:block;word-break:break-all;background:#f4f4f5;padding:.75rem;border-radius:.375rem;font-size:.75rem}' +
  'img{image-rendering:pixelated;width:16rem;height:16rem}</style></head><body>' +
  `<h1>Pix ${escapeHtml(reference)}</h1>` +
  `<p>Amount: R$ ${escapeHtml(amount.toFixed(2))}</p>` +
  `<img alt="Pix QR code" src="data:image/png;base64,${escapeHtml(png)}">` +
  '<h2>Pix copia e cola</h2>' +
  `<code>${escapeHtml(code)}</code></body></html>`;

/** The page `ticket_url` points at, for both Pix and boleto. */
export function paymentTicket(
  context: ServiceContext,
  id: string,
): Result<{ status: number; html: string }, ErrorBody> {
  const sequence = Number(id);
  if (!Number.isInteger(sequence)) return err(notFound());

  const found = context.store.payments.bySequence(sequence);
  if (found === null) return err(notFound());
  const payment = materialize(context, found);

  if (payment.method.code === 'pix') {
    const made = pixArtifacts(payment, sequence, {
      key: `${context.sandbox.id}@payground.local`,
      merchantName: 'PAYGROUND SANDBOX',
      merchantCity: 'SAO PAULO',
      baseUrl: context.baseUrl,
    });
    if (!made.ok) return err(notFound('ticket unavailable'));
    return ok({
      status: 200,
      html: pixTicket(made.value.qr_code, made.value.qr_code_base64, toDecimal(payment.amount), String(sequence)),
    });
  }

  const bankCode = BOLETO_BANKS[payment.method.code];
  if (payment.method.kind !== 'voucher' || bankCode === undefined) return err(notFound('ticket unavailable'));

  const made = boletoArtifacts(payment, sequence, { bankCode, baseUrl: context.baseUrl });
  if (!made.ok) return err(notFound('ticket unavailable'));

  return ok({
    status: 200,
    html: ticketHtml({
      barcode: made.value.barcode,
      line: made.value.line,
      amount: toDecimal(payment.amount),
      dueDate: payment.expiresAt === null ? null : new Date(payment.expiresAt),
      payerName: [payment.payer.firstName, payment.payer.lastName].filter(Boolean).join(' ') || payment.payer.email,
      payerDocument: payment.payer.documentNumber ?? '',
      description: payment.description ?? '',
      merchantName: 'PAYGROUND SANDBOX',
      reference: String(sequence),
    }),
  });
}
