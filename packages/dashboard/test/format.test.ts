import { describe, expect, test } from 'bun:test';
import {
  formatAmount,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatRelative,
  parseAmount,
} from '../src/lib/format.ts';

describe('formatAmount', () => {
  const cases: [number, string, string][] = [
    [0, 'BRL', 'BRL 0.00'],
    [1, 'BRL', 'BRL 0.01'],
    [99, 'BRL', 'BRL 0.99'],
    [100, 'BRL', 'BRL 1.00'],
    [123456, 'BRL', 'BRL 1,234.56'],
    [100000000, 'ARS', 'ARS 1,000,000.00'],
    [-2550, 'BRL', '-BRL 25.50'],
    [15000, 'CLP', 'CLP 15,000'],
    [70000000000000, 'BRL', 'BRL 700,000,000,000.00'],
  ];
  for (const [minor, currency, expected] of cases) {
    test(`${minor} ${currency}`, () => {
      expect(formatAmount(minor, currency)).toBe(expected);
    });
  }

  test('uppercases the currency', () => {
    expect(formatAmount(500, 'brl')).toBe('BRL 5.00');
  });
});

describe('parseAmount', () => {
  const cases: [string, string, number | null][] = [
    ['1', 'BRL', 100],
    ['1.5', 'BRL', 150],
    ['1.05', 'BRL', 105],
    ['1,05', 'BRL', 105],
    ['.5', 'BRL', 50],
    ['0.01', 'BRL', 1],
    ['12345.67', 'BRL', 1234567],
    ['1.005', 'BRL', null],
    ['', 'BRL', null],
    ['abc', 'BRL', null],
    ['1.2.3', 'BRL', null],
    ['-3', 'BRL', -300],
    ['15000', 'CLP', 15000],
    ['15000.5', 'CLP', null],
  ];
  for (const [input, currency, expected] of cases) {
    test(`"${input}" ${currency}`, () => {
      expect(parseAmount(input, currency)).toBe(expected);
    });
  }

  test('round-trips through formatAmount', () => {
    expect(parseAmount('1,234.56', 'BRL')).toBe(null);
    expect(parseAmount('1234.56', 'BRL')).toBe(123456);
  });
});

describe('dates', () => {
  test('formatDateTime uses UTC', () => {
    expect(formatDateTime(0)).toBe('1970-01-01 00:00:00Z');
    expect(formatDateTime(1_700_000_000_000)).toBe('2023-11-14 22:13:20Z');
  });

  test('formatDateTime handles non-finite input', () => {
    expect(formatDateTime(Number.NaN)).toBe('—');
  });

  test('formatDuration buckets', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59_000)).toBe('59s');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(90_000_000)).toBe('1d');
  });

  test('formatRelative', () => {
    expect(formatRelative(1000, 61_000)).toBe('1m ago');
    expect(formatRelative(61_000, 1000)).toBe('in 1m');
  });
});

test('formatPercent', () => {
  expect(formatPercent(0)).toBe('0%');
  expect(formatPercent(0.125)).toBe('12.5%');
  expect(formatPercent(1)).toBe('100%');
});
