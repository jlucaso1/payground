import { describe, expect, test } from 'bun:test';
import { SeededRandom } from '@payground/core/testing.ts';
import { unwrap } from '@payground/core';
import { type BrCodeInput, type BrCodeTlv, MAX, brCode, crc16, parseBrCode } from './brcode.ts';

function child(tlvs: BrCodeTlv[], id: string): BrCodeTlv | undefined {
  return tlvs.find((t) => t.id === id);
}

function valueOf(tlvs: BrCodeTlv[], id: string): string | undefined {
  return child(tlvs, id)?.value;
}

/** Independent scan: re-walks the raw payload and returns every segment it finds. */
function scan(payload: string): { id: string; declared: number; value: string }[] {
  const out: { id: string; declared: number; value: string }[] = [];
  let cursor = 0;
  while (cursor < payload.length) {
    const id = payload.slice(cursor, cursor + 2);
    const rawLength = payload.slice(cursor + 2, cursor + 4);
    expect(rawLength).toMatch(/^\d{2}$/);
    const declared = Number(rawLength);
    const value = payload.slice(cursor + 4, cursor + 4 + declared);
    expect(value.length).toBe(declared);
    out.push({ id, declared, value });
    cursor += 4 + declared;
  }
  expect(cursor).toBe(payload.length);
  return out;
}

const BASE: BrCodeInput = { key: 'john@yourdomain.com', merchantName: 'Test Store', merchantCity: 'Sao Paulo' };

describe('crc16', () => {
  test('CRC-16/CCITT-FALSE known answer', () => {
    expect(crc16('123456789')).toBe(0x29b1);
  });

  test('empty input is the init value', () => {
    expect(crc16('')).toBe(0xffff);
  });

  test('matches an independent table-driven implementation', () => {
    const table = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i << 8;
      for (let bit = 0; bit < 8; bit++) {
        value = (value & 0x8000) !== 0 ? ((value << 1) ^ 0x1021) & 0xffff : (value << 1) & 0xffff;
      }
      table[i] = value;
    }
    const tableCrc = (input: string): number => {
      let crc = 0xffff;
      for (const byte of new TextEncoder().encode(input)) {
        crc = ((crc << 8) & 0xffff) ^ (table[((crc >> 8) ^ byte) & 0xff] ?? 0);
      }
      return crc;
    };
    const rng = new SeededRandom(7);
    const pool = 'abcXYZ019 .@-çã北🙂';
    for (let i = 0; i < 500; i++) {
      let text = '';
      const size = rng.int(40);
      for (let j = 0; j < size; j++) text += pool[rng.int(pool.length)] ?? 'a';
      expect(crc16(text)).toBe(tableCrc(text));
    }
  });
});

describe('brCode structure', () => {
  test('emits the mandatory tags in ascending order', () => {
    const payload = unwrap(brCode({ ...BASE, amount: 100.5, txid: 'ABC123' }));
    const ids = scan(payload).map((s) => s.id);
    expect(ids).toEqual(['00', '26', '52', '53', '54', '58', '59', '60', '62', '63']);
    const tlvs = unwrap(parseBrCode(payload));
    expect(valueOf(tlvs, '00')).toBe('01');
    expect(valueOf(tlvs, '52')).toBe('0000');
    expect(valueOf(tlvs, '53')).toBe('986');
    expect(valueOf(tlvs, '54')).toBe('100.50');
    expect(valueOf(tlvs, '58')).toBe('BR');
    expect(valueOf(tlvs, '59')).toBe('Test Store');
    expect(valueOf(tlvs, '60')).toBe('Sao Paulo');
    const mai = child(tlvs, '26')?.children ?? [];
    expect(valueOf(mai, '00')).toBe('br.gov.bcb.pix');
    expect(valueOf(mai, '01')).toBe('john@yourdomain.com');
    expect(valueOf(child(tlvs, '62')?.children ?? [], '05')).toBe('ABC123');
  });

  test('point of initiation method only when oneTime', () => {
    const once = unwrap(brCode({ ...BASE, oneTime: true }));
    expect(scan(once).map((s) => s.id)).toContain('01');
    expect(valueOf(unwrap(parseBrCode(once)), '01')).toBe('12');
    expect(scan(unwrap(brCode({ ...BASE, oneTime: false }))).map((s) => s.id)).not.toContain('01');
    expect(scan(unwrap(brCode(BASE))).map((s) => s.id)).not.toContain('01');
  });

  test('amount omitted when undefined, reference label defaults to ***', () => {
    const payload = unwrap(brCode(BASE));
    expect(scan(payload).map((s) => s.id)).not.toContain('54');
    expect(valueOf(child(unwrap(parseBrCode(payload)), '62')?.children ?? [], '05')).toBe('***');
  });

  test('optional description and postal code', () => {
    const payload = unwrap(brCode({ ...BASE, description: 'Order 42', postalCode: '01310100' }));
    const tlvs = unwrap(parseBrCode(payload));
    expect(valueOf(child(tlvs, '26')?.children ?? [], '02')).toBe('Order 42');
    expect(valueOf(tlvs, '61')).toBe('01310100');
  });

  test('declares the true length for the key Mercado Pago documents wrongly as 17', () => {
    // https://www.mercadopago.com.br/developers/en/docs/checkout-api-payments/integration-configuration/integrate-pix
    const payload = unwrap(brCode(BASE));
    expect(payload).toContain('0119john@yourdomain.com');
    expect(payload).not.toContain('0117john@yourdomain.com');
  });

  test('CRC trailer is uppercase hex over the payload including 6304', () => {
    const payload = unwrap(brCode(BASE));
    expect(payload.slice(-8, -4)).toBe('6304');
    expect(payload.slice(-4)).toMatch(/^[0-9A-F]{4}$/);
    const expected = crc16(payload.slice(0, -4)).toString(16).toUpperCase().padStart(4, '0');
    expect(payload.slice(-4)).toBe(expected);
  });
});

describe('validation boundaries', () => {
  test('merchant name 25 accepted, 26 rejected', () => {
    expect(brCode({ ...BASE, merchantName: 'A'.repeat(25) }).ok).toBe(true);
    expect(brCode({ ...BASE, merchantName: 'A'.repeat(26) })).toEqual({
      ok: false,
      error: { kind: 'field_too_long', field: 'merchantName', max: 25, actual: 26 },
    });
  });

  test('merchant city 15 accepted, 16 rejected', () => {
    expect(brCode({ ...BASE, merchantCity: 'C'.repeat(15) }).ok).toBe(true);
    expect(brCode({ ...BASE, merchantCity: 'C'.repeat(16) })).toEqual({
      ok: false,
      error: { kind: 'field_too_long', field: 'merchantCity', max: 15, actual: 16 },
    });
  });

  test('txid 25 accepted, 26 rejected, non-alphanumeric rejected', () => {
    expect(brCode({ ...BASE, txid: 'a1'.repeat(12) + 'b' }).ok).toBe(true);
    expect(brCode({ ...BASE, txid: 'a'.repeat(26) })).toEqual({
      ok: false,
      error: { kind: 'field_too_long', field: 'txid', max: 25, actual: 26 },
    });
    expect(brCode({ ...BASE, txid: 'abc-123' })).toEqual({
      ok: false,
      error: { kind: 'invalid_character', field: 'txid' },
    });
  });

  test('postal code 8 accepted, 9 rejected', () => {
    expect(brCode({ ...BASE, postalCode: '12345678' }).ok).toBe(true);
    expect(brCode({ ...BASE, postalCode: '123456789' })).toEqual({
      ok: false,
      error: { kind: 'field_too_long', field: 'postalCode', max: 8, actual: 9 },
    });
  });

  test('description 72 accepted, 73 rejected', () => {
    expect(brCode({ ...BASE, key: 'a', description: 'd'.repeat(72) }).ok).toBe(true);
    expect(brCode({ ...BASE, key: 'a', description: 'd'.repeat(73) })).toEqual({
      ok: false,
      error: { kind: 'field_too_long', field: 'description', max: 72, actual: 73 },
    });
  });

  test('key 77 accepted, 78 rejected', () => {
    expect(brCode({ ...BASE, key: 'k'.repeat(77) }).ok).toBe(true);
    expect(brCode({ ...BASE, key: 'k'.repeat(78) })).toEqual({
      ok: false,
      error: { kind: 'field_too_long', field: 'key', max: 77, actual: 78 },
    });
  });

  test('merchant account information template capped at 99', () => {
    const result = brCode({ ...BASE, key: 'k'.repeat(60), description: 'd'.repeat(20) });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'field_too_long', field: 'merchantAccountInformation', max: 99, actual: 106 },
    });
  });

  test('empty required and optional fields', () => {
    expect(brCode({ ...BASE, key: '' })).toEqual({ ok: false, error: { kind: 'field_empty', field: 'key' } });
    expect(brCode({ ...BASE, merchantName: '' })).toEqual({
      ok: false,
      error: { kind: 'field_empty', field: 'merchantName' },
    });
    expect(brCode({ ...BASE, merchantCity: '' })).toEqual({
      ok: false,
      error: { kind: 'field_empty', field: 'merchantCity' },
    });
    expect(brCode({ ...BASE, txid: '' })).toEqual({ ok: false, error: { kind: 'field_empty', field: 'txid' } });
    expect(brCode({ ...BASE, description: '' })).toEqual({
      ok: false,
      error: { kind: 'field_empty', field: 'description' },
    });
    expect(brCode({ ...BASE, postalCode: '' })).toEqual({
      ok: false,
      error: { kind: 'field_empty', field: 'postalCode' },
    });
  });

  test('control characters rejected', () => {
    expect(brCode({ ...BASE, merchantName: 'Test\nStore' })).toEqual({
      ok: false,
      error: { kind: 'invalid_character', field: 'merchantName' },
    });
    expect(brCode({ ...BASE, key: 'a b' })).toEqual({
      ok: false,
      error: { kind: 'invalid_character', field: 'key' },
    });
  });

  test('amount rejections', () => {
    for (const amount of [0, -0, -1, -0.01, Number.NaN, Number.POSITIVE_INFINITY, 0.001, 1 / 3, 0.1 + 0.2]) {
      expect(brCode({ ...BASE, amount })).toEqual({ ok: false, error: { kind: 'invalid_amount', amount } });
    }
    expect(brCode({ ...BASE, amount: 1e20 }).ok).toBe(false);
  });

  test('amount formatting', () => {
    const formatted = (amount: number): string | undefined =>
      valueOf(unwrap(parseBrCode(unwrap(brCode({ ...BASE, amount })))), '54');
    expect(formatted(100.5)).toBe('100.50');
    expect(formatted(0.01)).toBe('0.01');
    expect(formatted(1)).toBe('1.00');
    expect(formatted(9999999.99)).toBe('9999999.99');
  });
});

describe('parseBrCode failures', () => {
  test('truncated input', () => {
    expect(parseBrCode('')).toEqual({ ok: false, error: { kind: 'truncated', offset: 0 } });
    expect(parseBrCode('000201')).toEqual({ ok: false, error: { kind: 'truncated', offset: 6 } });
  });

  test('missing CRC tag', () => {
    expect(parseBrCode('00020163051234')).toEqual({ ok: false, error: { kind: 'crc_missing' } });
  });

  test('CRC mismatch', () => {
    const payload = unwrap(brCode(BASE));
    const broken = `${payload.slice(0, -4)}0000`;
    const result = parseBrCode(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('crc_mismatch');
  });

  test('bad length and body truncation are reported with offsets', () => {
    const withCrc = (body: string): string => {
      const full = `${body}6304`;
      return full + crc16(full).toString(16).toUpperCase().padStart(4, '0');
    };
    const badLength = parseBrCode(withCrc('000201010Z12'));
    expect(badLength).toEqual({ ok: false, error: { kind: 'bad_length', id: '01', offset: 8 } });
    const badId = parseBrCode(withCrc('000201zz02ab'));
    expect(badId).toEqual({ ok: false, error: { kind: 'invalid_id', offset: 6 } });
    const truncated = parseBrCode(withCrc('000201593012'));
    expect(truncated).toEqual({ ok: false, error: { kind: 'truncated', offset: 10 } });
  });
});

describe('single-character mutations break the CRC', () => {
  const cases: BrCodeInput[] = [
    BASE,
    { ...BASE, amount: 12.34, txid: 'REF001', oneTime: true },
    { ...BASE, key: '+5511999998888', description: 'Order 7', postalCode: '01310100', amount: 1 },
  ];
  for (const [index, input] of cases.entries()) {
    test(`case ${index}`, () => {
      const payload = unwrap(brCode(input));
      expect(payload).toMatch(/^[\x20-\x7e]+$/);
      for (let i = 0; i < payload.length; i++) {
        const original = payload[i] ?? '';
        const replacement = original === 'X' ? 'Y' : 'X';
        const mutated = payload.slice(0, i) + replacement + payload.slice(i + 1);
        const result = parseBrCode(mutated);
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        const inCrcTag = i >= payload.length - 8 && i < payload.length - 4;
        expect(result.error.kind).toBe(inCrcTag ? 'crc_missing' : 'crc_mismatch');
      }
    });
  }
});

describe('round-trip fuzz', () => {
  const NAME_POOL = [
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .-&',
    'ç',
    'ã',
    'é',
    'Õ',
    '北',
    '京',
    'ü',
    '🙂',
    '🌎',
  ];
  const KEY_POOL = [...'abcdefghijklmnopqrstuvwxyz0123456789.-_+@'];
  const ALNUM_POOL = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];

  function text(rng: SeededRandom, pool: string[], maxUnits: number): string {
    const target = 1 + rng.int(maxUnits);
    let out = '';
    let guard = 0;
    while (out.length < target && guard++ < maxUnits * 4) {
      const piece = pool[rng.int(pool.length)] ?? 'a';
      if (out.length + piece.length > target) continue;
      out += piece;
    }
    return out.length === 0 ? 'a' : out;
  }

  test('parseBrCode(brCode(input)) recovers every field', () => {
    const rng = new SeededRandom(20240828);
    const iterations = 3000;
    let withAmount = 0;
    let withTxid = 0;
    let withDescription = 0;
    let withPostal = 0;
    let oneTimeCount = 0;

    for (let i = 0; i < iterations; i++) {
      const key = text(rng, KEY_POOL, MAX.key);
      const merchantName = text(rng, NAME_POOL, MAX.merchantName);
      const merchantCity = text(rng, NAME_POOL, MAX.merchantCity);
      // tag 26 budget: 18 for the GUI child + 4 header bytes per remaining child.
      const descriptionBudget = Math.min(MAX.description, MAX.merchantAccountInformation - 18 - 4 - key.length - 4);
      const description = descriptionBudget >= 1 && rng.int(2) === 0 ? text(rng, NAME_POOL, descriptionBudget) : undefined;
      const cents = rng.int(3) === 0 ? undefined : 1 + rng.int(999999999);
      const amount = cents === undefined ? undefined : cents / 100;
      const txid = rng.int(2) === 0 ? text(rng, ALNUM_POOL, MAX.txid) : undefined;
      const postalCode = rng.int(3) === 0 ? text(rng, [...'0123456789'], MAX.postalCode) : undefined;
      const oneTime = rng.int(2) === 0;

      const input: BrCodeInput = {
        key,
        merchantName,
        merchantCity,
        oneTime,
        ...(amount === undefined ? {} : { amount }),
        ...(txid === undefined ? {} : { txid }),
        ...(description === undefined ? {} : { description }),
        ...(postalCode === undefined ? {} : { postalCode }),
      };

      const generated = brCode(input);
      if (!generated.ok) throw new Error(`unexpected error ${JSON.stringify(generated.error)} for ${JSON.stringify(input)}`);
      const payload = generated.value;

      const segments = scan(payload);
      const ids = segments.map((s) => s.id);
      expect(ids).toEqual([...ids].sort());
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.at(-1)).toBe('63');
      for (const segment of segments) expect(segment.value.length).toBe(segment.declared);

      const parsed = parseBrCode(payload);
      if (!parsed.ok) throw new Error(`unexpected parse error ${JSON.stringify(parsed.error)}`);
      const tlvs = parsed.value;
      const mai = child(tlvs, '26')?.children ?? [];
      for (const nested of [mai, child(tlvs, '62')?.children ?? []]) {
        for (const node of nested) expect(node.value.length).toBeGreaterThan(0);
      }

      expect(valueOf(tlvs, '00')).toBe('01');
      expect(valueOf(tlvs, '01')).toBe(oneTime ? '12' : undefined);
      expect(valueOf(mai, '00')).toBe('br.gov.bcb.pix');
      expect(valueOf(mai, '01')).toBe(key);
      expect(valueOf(mai, '02')).toBe(description);
      expect(valueOf(tlvs, '52')).toBe('0000');
      expect(valueOf(tlvs, '53')).toBe('986');
      expect(valueOf(tlvs, '54')).toBe(amount === undefined ? undefined : amount.toFixed(2));
      if (amount !== undefined) expect(Number(valueOf(tlvs, '54'))).toBe(amount);
      expect(valueOf(tlvs, '58')).toBe('BR');
      expect(valueOf(tlvs, '59')).toBe(merchantName);
      expect(valueOf(tlvs, '60')).toBe(merchantCity);
      expect(valueOf(tlvs, '61')).toBe(postalCode);
      expect(valueOf(child(tlvs, '62')?.children ?? [], '05')).toBe(txid ?? '***');
      expect(valueOf(tlvs, '63')).toBe(payload.slice(-4));

      if (amount !== undefined) withAmount++;
      if (txid !== undefined) withTxid++;
      if (description !== undefined) withDescription++;
      if (postalCode !== undefined) withPostal++;
      if (oneTime) oneTimeCount++;
    }

    for (const count of [withAmount, withTxid, withDescription, withPostal, oneTimeCount]) {
      expect(count).toBeGreaterThan(iterations / 10);
      expect(count).toBeLessThan(iterations);
    }
  });
});
