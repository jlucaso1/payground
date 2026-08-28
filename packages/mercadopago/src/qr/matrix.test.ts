import { describe, expect, test } from 'bun:test';
import { SeededRandom } from '@payground/core/testing.ts';
import { isErr, unwrap } from '@payground/core';
import { type Ecc, qrCapacity, qrMatrix } from './index.ts';
import { byteCapacity, dataCodewords, eccCodewordsPerBlock, moduleCount, numBlocks, totalCodewords } from './tables.ts';
import { addEccAndInterleave, encodeDataCodewords } from './matrix.ts';

const LEVELS: readonly Ecc[] = ['L', 'M', 'Q', 'H'];
const versionOf = (matrix: boolean[][]): number => (matrix.length - 17) / 4;

describe('qr tables', () => {
  test('known codeword counts match ISO/IEC 18004', () => {
    expect(totalCodewords(1)).toBe(26);
    expect(totalCodewords(7)).toBe(196);
    expect(totalCodewords(40)).toBe(3706);
    expect(dataCodewords(1, 'M')).toBe(16);
    expect(dataCodewords(1, 'H')).toBe(9);
    expect(dataCodewords(40, 'L')).toBe(2956);
  });

  test('block splitting consumes exactly the data codewords', () => {
    for (let version = 1; version <= 40; version++) {
      for (const ecc of LEVELS) {
        const blocks = numBlocks(version, ecc);
        expect(dataCodewords(version, ecc) + eccCodewordsPerBlock(version, ecc) * blocks).toBe(totalCodewords(version));
      }
    }
  });

  test('byte capacities are monotonic in version and decrease with stronger ecc', () => {
    for (const ecc of LEVELS) {
      for (let version = 2; version <= 40; version++) {
        expect(byteCapacity(version, ecc)).toBeGreaterThan(byteCapacity(version - 1, ecc));
      }
    }
    for (let version = 1; version <= 40; version++) {
      expect(byteCapacity(version, 'L')).toBeGreaterThanOrEqual(byteCapacity(version, 'M'));
      expect(byteCapacity(version, 'M')).toBeGreaterThanOrEqual(byteCapacity(version, 'Q'));
      expect(byteCapacity(version, 'Q')).toBeGreaterThanOrEqual(byteCapacity(version, 'H'));
    }
  });
});

describe('qr codeword encoding', () => {
  test('emits mode, length, payload then the standard pad bytes', () => {
    const codewords = encodeDataCodewords(new TextEncoder().encode('AB'), 1, 'M');
    expect(codewords.length).toBe(16);
    // 0100 | 00000010 | 01000001 | 01000010 | 0000 terminator
    expect([...codewords.subarray(0, 4)]).toEqual([0x40, 0x24, 0x14, 0x20]);
    expect([...codewords.subarray(4)]).toEqual([0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]);
  });

  test('interleaving produces the full raw codeword stream for every version', () => {
    for (let version = 1; version <= 40; version++) {
      for (const ecc of LEVELS) {
        const data = encodeDataCodewords(new Uint8Array(0), version, ecc);
        expect(addEccAndInterleave(data, version, ecc).length).toBe(totalCodewords(version));
      }
    }
  });
});

describe('qrMatrix', () => {
  test('picks the smallest version that fits', () => {
    expect(versionOf(unwrap(qrMatrix('a'.repeat(14))))).toBe(1);
    expect(versionOf(unwrap(qrMatrix('a'.repeat(15))))).toBe(2);
    expect(versionOf(unwrap(qrMatrix('a'.repeat(byteCapacity(2, 'M')))))).toBe(2);
    expect(versionOf(unwrap(qrMatrix('a'.repeat(byteCapacity(2, 'M') + 1))))).toBe(3);
  });

  test('counts unicode payloads in utf-8 bytes', () => {
    expect(versionOf(unwrap(qrMatrix('é'.repeat(7))))).toBe(1);
    expect(versionOf(unwrap(qrMatrix('é'.repeat(8))))).toBe(2);
  });

  test('a realistic pix br code fits well within version 15 at ecc M', () => {
    const brcode =
      '00020126580014BR.GOV.BCB.PIX0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Payground SA6008SAO PAULO62070503***6304ABCD';
    const matrix = unwrap(qrMatrix(brcode, { ecc: 'M' }));
    expect(brcode.length).toBeGreaterThan(120);
    expect(versionOf(matrix)).toBeLessThanOrEqual(15);
  });

  test('matrix side is 21 + 4 * (version - 1)', () => {
    for (let version = 1; version <= 40; version++) {
      const matrix = unwrap(qrMatrix('x'.repeat(byteCapacity(version, 'M'))));
      expect(matrix.length).toBe(21 + 4 * (version - 1));
      expect(matrix.length).toBe(moduleCount(version));
      for (const row of matrix) expect(row.length).toBe(matrix.length);
    }
  });

  test('has finder patterns in three corners and none in the fourth', () => {
    const matrix = unwrap(qrMatrix('finder patterns', { ecc: 'Q' }));
    const size = matrix.length;
    const finder = (ox: number, oy: number): string =>
      Array.from({ length: 7 }, (_, y) => Array.from({ length: 7 }, (_, x) => (matrix[oy + y]![ox + x] ? '#' : '.')).join('')).join('/');
    const expected = ['#######', '#.....#', '#.###.#', '#.###.#', '#.###.#', '#.....#', '#######'].join('/');

    expect(finder(0, 0)).toBe(expected);
    expect(finder(size - 7, 0)).toBe(expected);
    expect(finder(0, size - 7)).toBe(expected);
    expect(finder(size - 7, size - 7)).not.toBe(expected);
  });

  test('separators around the finders are light', () => {
    const matrix = unwrap(qrMatrix('separators'));
    const size = matrix.length;
    for (let i = 0; i < 8; i++) {
      expect(matrix[7]![i]).toBe(false);
      expect(matrix[i]![7]).toBe(false);
      expect(matrix[7]![size - 1 - i]).toBe(false);
      expect(matrix[size - 1 - i]![7]).toBe(false);
    }
  });

  test('timing patterns alternate and the dark module is set', () => {
    const matrix = unwrap(qrMatrix('timing pattern check', { ecc: 'H' }));
    const size = matrix.length;
    for (let i = 8; i < size - 8; i++) {
      expect(matrix[6]![i]).toBe(i % 2 === 0);
      expect(matrix[i]![6]).toBe(i % 2 === 0);
    }
    expect(matrix[size - 8]![8]).toBe(true);
  });

  test('is deterministic for the same input', () => {
    for (const ecc of LEVELS) {
      const a = unwrap(qrMatrix('deterministic payload', { ecc }));
      const b = unwrap(qrMatrix('deterministic payload', { ecc }));
      expect(a).toEqual(b);
    }
  });

  test('different ecc levels give different matrices', () => {
    const m = unwrap(qrMatrix('same text'));
    const h = unwrap(qrMatrix('same text', { ecc: 'H' }));
    expect(m).not.toEqual(h);
  });

  test('rejects payloads beyond the largest version', () => {
    for (const ecc of LEVELS) {
      const capacity = qrCapacity(ecc);
      expect(unwrap(qrMatrix('a'.repeat(capacity), { ecc })).length).toBe(177);
      const result = qrMatrix('a'.repeat(capacity + 1), { ecc });
      expect(isErr(result)).toBe(true);
      if (!result.ok) expect(result.error).toEqual({ kind: 'too_long', length: capacity + 1, capacity });
    }
  });

  test('rejects an unknown ecc level', () => {
    const result = qrMatrix('x', { ecc: 'Z' as Ecc });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_option', option: 'ecc' });
  });

  test('encodes the empty string', () => {
    expect(versionOf(unwrap(qrMatrix('')))).toBe(1);
  });

  test('random payloads always produce a well formed matrix', () => {
    const rng = new SeededRandom(20240828);
    for (let i = 0; i < 200; i++) {
      const ecc = LEVELS[rng.int(LEVELS.length)]!;
      const length = rng.int(300);
      const text = Array.from({ length }, () => String.fromCharCode(32 + rng.int(95))).join('');
      const matrix = unwrap(qrMatrix(text, { ecc }));
      expect(matrix.length).toBe(moduleCount(versionOf(matrix)));
      expect(matrix.length % 4).toBe(1);
      expect(matrix[0]![0]).toBe(true);
    }
  });
});
