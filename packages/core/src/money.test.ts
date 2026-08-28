import { describe, expect, test } from 'bun:test';
import { SeededRandom } from './testing.ts';
import { ZERO, add, fromDecimal, minor, subtract, toDecimal } from './money.ts';
import { isErr, isOk, unwrap } from './result.ts';

const cents = (n: number) => unwrap(minor(n));

describe('money', () => {
  test('rejects values that cannot be an amount', () => {
    expect(isErr(minor(1.5))).toBe(true);
    expect(isErr(minor(-1))).toBe(true);
    expect(isErr(minor(Number.NaN))).toBe(true);
    expect(isErr(minor(Number.POSITIVE_INFINITY))).toBe(true);
    expect(isErr(minor(Number.MAX_SAFE_INTEGER + 2))).toBe(true);
    expect(isOk(minor(0))).toBe(true);
  });

  test('converts wire decimals without float drift', () => {
    expect(Number(unwrap(fromDecimal(100.5)))).toBe(10_050);
    expect(Number(unwrap(fromDecimal(1.1)))).toBe(110);
    expect(Number(unwrap(fromDecimal(0.07)))).toBe(7);
    expect(Number(unwrap(fromDecimal(0)))).toBe(0);
  });

  test('refuses amounts with more precision than the currency has', () => {
    const result = fromDecimal(1.005);
    expect(isErr(result)).toBe(true);
    expect(isOk(fromDecimal(1.005, 3))).toBe(true);
  });

  test('round trips every amount up to ten million cents', () => {
    const rng = new SeededRandom(11);
    for (let i = 0; i < 20_000; i++) {
      const value = cents(rng.int(10_000_000));
      expect(Number(unwrap(fromDecimal(toDecimal(value))))).toBe(Number(value));
    }
  });

  test('arithmetic stays inside the type', () => {
    expect(Number(unwrap(add(cents(1), cents(2))))).toBe(3);
    expect(Number(unwrap(subtract(cents(3), cents(1))))).toBe(2);
    expect(isErr(subtract(cents(1), cents(3)))).toBe(true);
    expect(Number(ZERO)).toBe(0);
  });
});
