import { describe, expect, test } from 'bun:test';
import { amount, payment } from '@payground/core/payment/fixture.ts';
import { parseLinhaDigitavel } from '../boleto/index.ts';
import { boletoArtifacts } from './boleto.ts';

const voucher = (overrides = {}) => ({
  ...payment({ kind: 'pending', reason: 'awaiting_payer' }, { expiresAt: Date.UTC(2026, 0, 15) }),
  method: { kind: 'voucher' as const, code: 'bolbradesco', card: null },
  amount: amount(12_345),
  ...overrides,
});

const settings = { bankCode: '237', baseUrl: 'http://localhost:8080' };

describe('boleto artifacts', () => {
  test('produces a 44 digit barcode and a matching linha digitavel', () => {
    const made = boletoArtifacts(voucher(), 1_000_000_042, settings);
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    expect(made.value.barcode).toHaveLength(44);
    expect(made.value.barcode).toMatch(/^\d{44}$/);
    expect(made.value.barcode.slice(0, 3)).toBe('237');
    expect(made.value.barcode.slice(3, 4)).toBe('9');
    expect(made.value.barcode.slice(9, 19)).toBe('0000012345');

    const recovered = parseLinhaDigitavel(made.value.line);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) expect(recovered.value).toBe(made.value.barcode);
  });

  test('is deterministic for the same payment', () => {
    const p = voucher();
    expect(boletoArtifacts(p, 7, settings)).toEqual(boletoArtifacts(p, 7, settings));
  });

  test('a different sequence yields a different barcode', () => {
    const p = voucher();
    const a = boletoArtifacts(p, 7, settings);
    const b = boletoArtifacts(p, 8, settings);
    expect(a.ok && b.ok && a.value.barcode === b.value.barcode).toBe(false);
  });

  test('the ticket url points at this instance', () => {
    const made = boletoArtifacts(voucher(), 42, settings);
    expect(made.ok && made.value.ticket_url).toBe('http://localhost:8080/payments/42/ticket');
  });

  test('a payment with no deadline uses the no-due-date factor', () => {
    const made = boletoArtifacts(voucher({ expiresAt: null }), 1, settings);
    expect(made.ok).toBe(true);
    if (made.ok) expect(made.value.barcode.slice(5, 9)).toBe('0000');
  });

  test('an amount beyond the field width is refused as a value, not a throw', () => {
    const made = boletoArtifacts(voucher({ amount: amount(99_999_999_999) }), 1, settings);
    expect(made.ok).toBe(false);
  });
});
