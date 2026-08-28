import { type Result, err, ok } from '@payground/core';

export interface BrCodeInput {
  key: string;
  merchantName: string;
  merchantCity: string;
  amount?: number;
  txid?: string;
  description?: string;
  postalCode?: string;
  oneTime?: boolean;
}

export type BrCodeError =
  | { kind: 'field_too_long'; field: string; max: number; actual: number }
  | { kind: 'field_empty'; field: string }
  | { kind: 'invalid_amount'; amount: number }
  | { kind: 'invalid_character'; field: string };

export interface BrCodeTlv {
  id: string;
  value: string;
  children?: BrCodeTlv[];
}

export type BrCodeParseError =
  | { kind: 'truncated'; offset: number }
  | { kind: 'invalid_id'; offset: number }
  | { kind: 'bad_length'; id: string; offset: number }
  | { kind: 'crc_missing' }
  | { kind: 'crc_mismatch'; declared: string; computed: string };

export const PIX_GUI = 'br.gov.bcb.pix';

export const MAX = {
  key: 77,
  description: 72,
  merchantAccountInformation: 99,
  merchantName: 25,
  merchantCity: 15,
  postalCode: 8,
  txid: 25,
  amount: 13,
} as const;

// Lengths are counted in UTF-16 code units (JS `String.length`) while the CRC is computed over the
// UTF-8 bytes, as BCB requires. Both only diverge for non-ASCII payloads, and the parser follows the
// same convention as the generator, so round-tripping stays exact.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const ALNUM = /^[0-9A-Za-z]+$/;
const TWO_DECIMALS = /^\d+\.\d{2}$/;
const TWO_DIGITS = /^\d{2}$/;
const NESTED_TEMPLATES = new Set(['26', '62']);

function tlv(id: string, value: string): string {
  return id + String(value.length).padStart(2, '0') + value;
}

function checkField(field: string, value: string, max: number): Result<string, BrCodeError> {
  if (value.length === 0) return err({ kind: 'field_empty', field });
  if (value.length > max) return err({ kind: 'field_too_long', field, max, actual: value.length });
  if (CONTROL.test(value)) return err({ kind: 'invalid_character', field });
  return ok(value);
}

function formatAmount(amount: number): Result<string, BrCodeError> {
  if (!Number.isFinite(amount) || amount <= 0) return err({ kind: 'invalid_amount', amount });
  const text = amount.toFixed(2);
  if (!TWO_DECIMALS.test(text) || Number(text) !== amount) return err({ kind: 'invalid_amount', amount });
  if (text.length > MAX.amount) {
    return err({ kind: 'field_too_long', field: 'amount', max: MAX.amount, actual: text.length });
  }
  return ok(text);
}

export function brCode(input: BrCodeInput): Result<string, BrCodeError> {
  const key = checkField('key', input.key, MAX.key);
  if (!key.ok) return key;
  const name = checkField('merchantName', input.merchantName, MAX.merchantName);
  if (!name.ok) return name;
  const city = checkField('merchantCity', input.merchantCity, MAX.merchantCity);
  if (!city.ok) return city;

  let mai = tlv('00', PIX_GUI) + tlv('01', key.value);
  if (input.description !== undefined) {
    const description = checkField('description', input.description, MAX.description);
    if (!description.ok) return description;
    mai += tlv('02', description.value);
  }
  if (mai.length > MAX.merchantAccountInformation) {
    return err({
      kind: 'field_too_long',
      field: 'merchantAccountInformation',
      max: MAX.merchantAccountInformation,
      actual: mai.length,
    });
  }

  const parts: string[] = [tlv('00', '01')];
  if (input.oneTime === true) parts.push(tlv('01', '12'));
  parts.push(tlv('26', mai), tlv('52', '0000'), tlv('53', '986'));

  if (input.amount !== undefined) {
    const amount = formatAmount(input.amount);
    if (!amount.ok) return amount;
    parts.push(tlv('54', amount.value));
  }

  parts.push(tlv('58', 'BR'), tlv('59', name.value), tlv('60', city.value));

  if (input.postalCode !== undefined) {
    const postalCode = checkField('postalCode', input.postalCode, MAX.postalCode);
    if (!postalCode.ok) return postalCode;
    parts.push(tlv('61', postalCode.value));
  }

  let reference = '***';
  if (input.txid !== undefined) {
    const txid = checkField('txid', input.txid, MAX.txid);
    if (!txid.ok) return txid;
    if (!ALNUM.test(txid.value)) return err({ kind: 'invalid_character', field: 'txid' });
    reference = txid.value;
  }
  parts.push(tlv('62', tlv('05', reference)));

  const body = `${parts.join('')}6304`;
  return ok(body + hex4(crc16(body)));
}

export function crc16(input: string): number {
  const bytes = new TextEncoder().encode(input);
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function hex4(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

export function parseBrCode(payload: string): Result<BrCodeTlv[], BrCodeParseError> {
  if (payload.length < 8) return err({ kind: 'truncated', offset: payload.length });
  if (payload.slice(-8, -4) !== '6304') return err({ kind: 'crc_missing' });
  const declared = payload.slice(-4);
  const computed = hex4(crc16(payload.slice(0, -4)));
  if (declared !== computed) return err({ kind: 'crc_mismatch', declared, computed });
  return parseTlvs(payload, 0);
}

function parseTlvs(input: string, base: number): Result<BrCodeTlv[], BrCodeParseError> {
  const out: BrCodeTlv[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    if (cursor + 4 > input.length) return err({ kind: 'truncated', offset: base + cursor });
    const id = input.slice(cursor, cursor + 2);
    const rawLength = input.slice(cursor + 2, cursor + 4);
    if (!TWO_DIGITS.test(id)) return err({ kind: 'invalid_id', offset: base + cursor });
    if (!TWO_DIGITS.test(rawLength)) return err({ kind: 'bad_length', id, offset: base + cursor + 2 });
    const length = Number(rawLength);
    const start = cursor + 4;
    if (start + length > input.length) return err({ kind: 'truncated', offset: base + start });
    const value = input.slice(start, start + length);
    if (NESTED_TEMPLATES.has(id)) {
      const children = parseTlvs(value, base + start);
      if (!children.ok) return children;
      out.push({ id, value, children: children.value });
    } else {
      out.push({ id, value });
    }
    cursor = start + length;
  }
  return ok(out);
}

// Fidelity: the sample BR Code printed in Mercado Pago's Pix guide
// (https://www.mercadopago.com.br/developers/en/docs/checkout-api-payments/integration-configuration/integrate-pix)
// is not a valid EMV MPM payload: its tag 26 declares length 60 while carrying 64 characters, and the
// nested `0117john@yourdomain.com` declares 17 for a 19-character value. We emit a spec-correct
// payload instead of reproducing those broken lengths.
