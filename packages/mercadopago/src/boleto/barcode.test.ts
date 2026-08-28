import { describe, expect, test } from 'bun:test';
import { SeededRandom } from '@payground/core/testing.ts';
import { unwrap } from '@payground/core';
import {
  type BoletoError,
  MAX_CENTS,
  barcode,
  dueDateFactor,
  linhaDigitavel,
  modulo10,
  modulo11,
  parseLinhaDigitavel,
} from './barcode.ts';

/**
 * Canonical FEBRABAN worked example (Banco do Brasil, R$ 1,00, factor 3737):
 * barcode 00193373700000001000500940144816060680935031
 * linha   00190.50095 40144.816069 06809.350314 3 37370000000100
 */
const KNOWN_BARCODE = '00193373700000001000500940144816060680935031';
const KNOWN_LINE = '00190.50095 40144.816069 06809.350314 3 37370000000100';
const KNOWN_FREE = '0500940144816060680935031';
const KNOWN_DUE = new Date(Date.UTC(2007, 11, 31));

function errorOf(result: { ok: boolean; error?: BoletoError }): BoletoError {
  expect(result.ok).toBe(false);
  return result.error as BoletoError;
}

describe('modulo10', () => {
  test('Luhn known answer (ISO/IEC 7812 example 7992739871 -> 3)', () => {
    expect(modulo10('7992739871')).toBe(3);
  });

  test('linha digitavel fields of the canonical example', () => {
    expect(modulo10('001905009')).toBe(5);
    expect(modulo10('4014481606')).toBe(9);
    expect(modulo10('0680935031')).toBe(4);
  });

  test('doubling and digit-sum edge cases', () => {
    expect(modulo10('0')).toBe(0);
    expect(modulo10('1')).toBe(8);
    expect(modulo10('5')).toBe(9); // 5*2 = 10 -> 1+0 = 1, dv = 10 - 1
    expect(modulo10('00000000000000000000')).toBe(0);
  });

  test('detects every single-digit substitution', () => {
    const rng = new SeededRandom(11);
    for (let i = 0; i < 500; i++) {
      let body = '';
      for (let j = 0; j < 10; j++) body += rng.int(10);
      const dv = modulo10(body);
      for (let pos = 0; pos < body.length; pos++) {
        for (let d = 0; d < 10; d++) {
          if (String(d) === body[pos]) continue;
          expect(modulo10(body.slice(0, pos) + d + body.slice(pos + 1))).not.toBe(dv);
        }
      }
    }
  });
});

describe('modulo11', () => {
  test('barcode check digit of the canonical example', () => {
    expect(modulo11('0019373700000001000500940144816060680935031')).toBe(3);
  });

  test('plain remainder', () => {
    expect(modulo11('1')).toBe(9); // sum 2, remainder 2, 11 - 2 = 9
  });

  test('the 0 / 1 / 10 remainders all collapse to 1', () => {
    expect(modulo11('0')).toBe(1); // remainder 0 -> 11 -> 1
    expect(modulo11('6')).toBe(1); // sum 12, remainder 1 -> 10 -> 1
    expect(modulo11('5')).toBe(1); // sum 10, remainder 10 -> 1
  });

  test('weights cycle 2..9 from right to left', () => {
    // Ten ones: weights 2,3,4,5,6,7,8,9,2,3 -> sum 49, remainder 5, dv 6.
    expect(modulo11('1111111111')).toBe(6);
  });
});

describe('dueDateFactor', () => {
  test('null means no due date', () => {
    expect(unwrap(dueDateFactor(null))).toBe('0000');
  });

  test('first factor in use, 03/07/2000 -> 1000', () => {
    expect(unwrap(dueDateFactor(new Date(Date.UTC(2000, 6, 3))))).toBe('1000');
  });

  test('canonical example, 31/12/2007 -> 3737', () => {
    expect(unwrap(dueDateFactor(KNOWN_DUE))).toBe('3737');
  });

  test('rollover boundary: 21/02/2025 -> 9999, 22/02/2025 -> 1000', () => {
    expect(unwrap(dueDateFactor(new Date(Date.UTC(2025, 1, 21))))).toBe('9999');
    expect(unwrap(dueDateFactor(new Date(Date.UTC(2025, 1, 22))))).toBe('1000');
    expect(unwrap(dueDateFactor(new Date(Date.UTC(2025, 1, 23))))).toBe('1001');
  });

  test('second rollover stays in cycle', () => {
    const secondEnd = new Date(Date.UTC(2025, 1, 22) + 8999 * 86_400_000);
    expect(unwrap(dueDateFactor(secondEnd))).toBe('9999');
    expect(unwrap(dueDateFactor(new Date(secondEnd.getTime() + 86_400_000)))).toBe('1000');
  });

  test('time of day is ignored (UTC calendar day)', () => {
    expect(unwrap(dueDateFactor(new Date('2025-02-21T23:59:59.999Z')))).toBe('9999');
    expect(unwrap(dueDateFactor(new Date('2025-02-21T00:00:00.000Z')))).toBe('9999');
  });

  test('dates before the first factor and invalid dates are rejected', () => {
    expect(errorOf(dueDateFactor(new Date(Date.UTC(2000, 6, 2))))).toMatchObject({
      kind: 'invalid_field',
      field: 'dueDate',
    });
    expect(errorOf(dueDateFactor(new Date(Number.NaN)))).toMatchObject({ kind: 'invalid_field', field: 'dueDate' });
  });

  test('factor stays within 1000..9999 for a long span of days', () => {
    for (let day = 1000; day < 30_000; day++) {
      const factor = Number(unwrap(dueDateFactor(new Date(Date.UTC(1997, 9, 7) + day * 86_400_000))));
      expect(factor).toBeGreaterThanOrEqual(1000);
      expect(factor).toBeLessThanOrEqual(9999);
    }
  });
});

describe('barcode', () => {
  test('reproduces the canonical example', () => {
    const result = barcode({ bankCode: '001', amount: 1, dueDate: KNOWN_DUE, freeField: KNOWN_FREE });
    expect(unwrap(result)).toBe(KNOWN_BARCODE);
  });

  test('currency defaults to 9 and can be overridden', () => {
    const base = { bankCode: '237', amount: 10, dueDate: null, freeField: '0'.repeat(25) };
    expect(unwrap(barcode(base)).slice(0, 4)).toBe('2379');
    expect(unwrap(barcode({ ...base, currencyCode: '0' })).slice(0, 4)).toBe('2370');
  });

  test('field layout', () => {
    const value = unwrap(barcode({ bankCode: '341', amount: 1234.56, dueDate: KNOWN_DUE, freeField: KNOWN_FREE }));
    expect(value).toHaveLength(44);
    expect(value.slice(0, 3)).toBe('341');
    expect(value[3]).toBe('9');
    expect(value.slice(5, 9)).toBe('3737');
    expect(value.slice(9, 19)).toBe('0000123456');
    expect(value.slice(19)).toBe(KNOWN_FREE);
  });

  test('null due date yields factor 0000', () => {
    expect(unwrap(barcode({ bankCode: '033', amount: 1, dueDate: null, freeField: KNOWN_FREE })).slice(5, 9)).toBe(
      '0000',
    );
  });

  describe('amount bounds', () => {
    const base = { bankCode: '104', dueDate: null, freeField: KNOWN_FREE } as const;

    test('zero is allowed', () => {
      expect(unwrap(barcode({ ...base, amount: 0 })).slice(9, 19)).toBe('0000000000');
    });

    test('maximum of ten digits of cents', () => {
      expect(unwrap(barcode({ ...base, amount: MAX_CENTS / 100 })).slice(9, 19)).toBe('9999999999');
    });

    test('one cent over the maximum is out of range', () => {
      expect(errorOf(barcode({ ...base, amount: (MAX_CENTS + 1) / 100 }))).toEqual({
        kind: 'amount_out_of_range',
        amount: 100_000_000,
      });
    });

    test('negative and non-finite amounts are out of range', () => {
      for (const amount of [-0.01, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(errorOf(barcode({ ...base, amount })).kind).toBe('amount_out_of_range');
      }
    });

    test('sub-cent precision is rejected', () => {
      expect(errorOf(barcode({ ...base, amount: 1.005 }))).toMatchObject({
        kind: 'invalid_field',
        field: 'amount',
      });
    });

    test('binary floating point cents round correctly', () => {
      expect(unwrap(barcode({ ...base, amount: 0.07 })).slice(9, 19)).toBe('0000000007');
      expect(unwrap(barcode({ ...base, amount: 1.1 })).slice(9, 19)).toBe('0000000110');
      expect(unwrap(barcode({ ...base, amount: 8_364.62 })).slice(9, 19)).toBe('0000836462');
    });
  });

  test('free field must be exactly 25 digits', () => {
    const base = { bankCode: '104', amount: 1, dueDate: null };
    for (const freeField of ['', '0'.repeat(24), '0'.repeat(26), `${'0'.repeat(24)}a`, '0'.repeat(25).replace('0', ' ')]) {
      expect(errorOf(barcode({ ...base, freeField }))).toMatchObject({ kind: 'invalid_field', field: 'freeField' });
    }
    expect(barcode({ ...base, freeField: '0'.repeat(25) }).ok).toBe(true);
  });

  test('bank and currency codes are validated', () => {
    const base = { amount: 1, dueDate: null, freeField: KNOWN_FREE };
    for (const bankCode of ['', '1', '12', '1234', '00a']) {
      expect(errorOf(barcode({ ...base, bankCode }))).toMatchObject({ kind: 'invalid_field', field: 'bankCode' });
    }
    for (const currencyCode of ['', '99', 'a']) {
      expect(errorOf(barcode({ ...base, bankCode: '001', currencyCode }))).toMatchObject({
        kind: 'invalid_field',
        field: 'currencyCode',
      });
    }
  });
});

describe('linhaDigitavel', () => {
  test('canonical barcode -> canonical linha digitavel', () => {
    expect(unwrap(linhaDigitavel(KNOWN_BARCODE))).toBe(KNOWN_LINE);
  });

  test('formatting shape', () => {
    expect(KNOWN_LINE).toMatch(/^\d{5}\.\d{5} \d{5}\.\d{6} \d{5}\.\d{6} \d \d{14}$/);
    expect(KNOWN_LINE.replace(/[ .]/g, '')).toHaveLength(47);
  });

  test('rejects malformed barcodes and a wrong check digit', () => {
    for (const bad of ['', '1'.repeat(43), '1'.repeat(45), `${'1'.repeat(43)}a`]) {
      expect(errorOf(linhaDigitavel(bad))).toMatchObject({ kind: 'invalid_field', field: 'barcode' });
    }
    const wrongDv = `${KNOWN_BARCODE.slice(0, 4)}4${KNOWN_BARCODE.slice(5)}`;
    expect(errorOf(linhaDigitavel(wrongDv))).toMatchObject({ kind: 'invalid_field', field: 'barcode' });
  });
});

describe('parseLinhaDigitavel', () => {
  test('canonical linha digitavel -> canonical barcode', () => {
    expect(unwrap(parseLinhaDigitavel(KNOWN_LINE))).toBe(KNOWN_BARCODE);
  });

  test('accepts the unformatted 47 digits', () => {
    expect(unwrap(parseLinhaDigitavel(KNOWN_LINE.replace(/[ .]/g, '')))).toBe(KNOWN_BARCODE);
  });

  test('rejects wrong lengths and non-digits', () => {
    for (const bad of ['', KNOWN_LINE.slice(0, -1), `${KNOWN_LINE}0`, KNOWN_LINE.replace('0', 'x')]) {
      expect(errorOf(parseLinhaDigitavel(bad))).toMatchObject({ kind: 'invalid_field', field: 'line' });
    }
  });

  test('reports which field failed', () => {
    const digits = KNOWN_LINE.replace(/[ .]/g, '');
    const bump = (pos: number): string =>
      digits.slice(0, pos) + ((Number(digits[pos]) + 1) % 10) + digits.slice(pos + 1);
    expect(errorOf(parseLinhaDigitavel(bump(0)))).toMatchObject({ field: 'field1' });
    expect(errorOf(parseLinhaDigitavel(bump(12)))).toMatchObject({ field: 'field2' });
    expect(errorOf(parseLinhaDigitavel(bump(23)))).toMatchObject({ field: 'field3' });
    expect(errorOf(parseLinhaDigitavel(bump(32)))).toMatchObject({ field: 'barcode' });
  });
});

function randomInput(rng: SeededRandom): {
  bankCode: string;
  currencyCode: string;
  amount: number;
  dueDate: Date | null;
  freeField: string;
} {
  let bankCode = '';
  for (let i = 0; i < 3; i++) bankCode += rng.int(10);
  let freeField = '';
  for (let i = 0; i < 25; i++) freeField += rng.int(10);
  const dueDate =
    rng.int(10) === 0 ? null : new Date(Date.UTC(1997, 9, 7) + (1000 + rng.int(20_000)) * 86_400_000);
  return {
    bankCode,
    currencyCode: String(rng.int(10)),
    amount: (rng.int(10) === 0 ? MAX_CENTS - rng.int(1000) : rng.int(100_000_000)) / 100,
    dueDate,
    freeField,
  };
}

describe('round trip', () => {
  test('parseLinhaDigitavel(linhaDigitavel(barcode(x))) returns the same 44 digits', () => {
    const rng = new SeededRandom(2024);
    for (let i = 0; i < 5000; i++) {
      const bar = unwrap(barcode(randomInput(rng)));
      expect(bar).toHaveLength(44);
      const line = unwrap(linhaDigitavel(bar));
      expect(unwrap(parseLinhaDigitavel(line))).toBe(bar);
    }
  });

  test('the reconstructed barcode agrees with the input fields', () => {
    const rng = new SeededRandom(99);
    for (let i = 0; i < 1000; i++) {
      const input = randomInput(rng);
      const bar = unwrap(parseLinhaDigitavel(unwrap(linhaDigitavel(unwrap(barcode(input))))));
      expect(bar.slice(0, 3)).toBe(input.bankCode);
      expect(bar[3]).toBe(input.currencyCode);
      expect(bar.slice(5, 9)).toBe(unwrap(dueDateFactor(input.dueDate)));
      expect(Number(bar.slice(9, 19))).toBe(Math.round(input.amount * 100));
      expect(bar.slice(19)).toBe(input.freeField);
    }
  });

  test('mutating any single digit breaks a check digit', () => {
    const rng = new SeededRandom(7);
    let field5Collapses = 0;
    for (let i = 0; i < 200; i++) {
      const bar = unwrap(barcode(randomInput(rng)));
      const digits = unwrap(linhaDigitavel(bar)).replace(/[ .]/g, '');
      for (let pos = 0; pos < 47; pos++) {
        for (let d = 0; d < 10; d++) {
          if (String(d) === digits[pos]) continue;
          const mutated = digits.slice(0, pos) + d + digits.slice(pos + 1);
          const parsed = parseLinhaDigitavel(mutated);
          if (pos < 33) {
            // Fields 1-3 are Luhn-protected and field 4 is the barcode check digit itself.
            expect(parsed.ok).toBe(false);
            continue;
          }
          // Field 5 (factor + amount) is only covered by the barcode modulo 11, whose 0/1/10 -> 1
          // substitution is not injective, so a few substitutions are undetectable by design.
          if (parsed.ok) {
            field5Collapses++;
            expect(digits[32]).toBe('1');
            expect(parsed.value).not.toBe(bar);
          }
        }
      }
    }
    // Expected rate of the blind spot: both remainders must land in {0, 1, 10}, ~ (3/11) * (2/10).
    const mutations = 200 * 14 * 9;
    expect(field5Collapses).toBeGreaterThan(0);
    expect(field5Collapses / mutations).toBeLessThan(0.08);
  });
});
