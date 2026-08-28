import { describe, expect, test } from 'bun:test';
import { SeededRandom } from '@payground/core/testing.ts';
import { formatDateTime, formatOptional } from './datetime.ts';

describe('datetime', () => {
  test('renders the documented shape', () => {
    expect(formatDateTime(Date.UTC(2024, 0, 15, 13, 30, 0, 0))).toBe('2024-01-15T10:30:00.000-03:00');
  });

  test('keeps millisecond precision and pads every field', () => {
    expect(formatDateTime(Date.UTC(2024, 8, 5, 4, 7, 9, 40))).toBe('2024-09-05T01:07:09.040-03:00');
  });

  test('supports other offsets, including positive and half-hour ones', () => {
    const at = Date.UTC(2024, 0, 15, 12, 0, 0, 0);
    expect(formatDateTime(at, 0)).toBe('2024-01-15T12:00:00.000+00:00');
    expect(formatDateTime(at, 330)).toBe('2024-01-15T17:30:00.000+05:30');
    expect(formatDateTime(at, -270)).toBe('2024-01-15T07:30:00.000-04:30');
  });

  test('null passes through', () => {
    expect(formatOptional(null)).toBeNull();
    expect(formatOptional(0)).toBe('1969-12-31T21:00:00.000-03:00');
  });

  test('every rendered instant parses back to itself', () => {
    const rng = new SeededRandom(3);
    for (let i = 0; i < 5_000; i++) {
      const at = Date.UTC(2020, 0, 1) + rng.int(200_000_000) * 37;
      for (const offset of [0, -180, 330, -270, 720]) {
        expect(Date.parse(formatDateTime(at, offset))).toBe(at);
      }
    }
  });
});
