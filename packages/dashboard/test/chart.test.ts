import { describe, expect, test } from 'bun:test';
import {
  band,
  bucketByTime,
  formatClock,
  formatMs,
  isError,
  linePath,
  n2,
  niceMax,
  percentile,
  rate,
  scaleLength,
  seriesColor,
  tickCount,
  ticks,
  timeRange,
} from '../src/lib/chart.ts';

describe('percentile', () => {
  test('is zero for an empty sample', () => {
    expect(percentile([], 0.95)).toBe(0);
  });

  test('uses nearest rank', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 0.95)).toBe(100);
    expect(percentile(values, 0.9)).toBe(90);
  });

  test('does not mutate the input and tolerates unsorted data', () => {
    const values = [30, 10, 20];
    expect(percentile(values, 0.5)).toBe(20);
    expect(values).toEqual([30, 10, 20]);
  });

  test('clamps p outside 0..1', () => {
    expect(percentile([1, 2, 3], -1)).toBe(1);
    expect(percentile([1, 2, 3], 5)).toBe(3);
  });
});

describe('bucketByTime', () => {
  const events = [
    { at: 0, status: 200 },
    { at: 5, status: 500 },
    { at: 10, status: 200 },
    { at: 19, status: 404 },
  ];

  test('splits the window evenly and counts errors', () => {
    const buckets = bucketByTime(events, 0, 20, 2);
    expect(buckets).toEqual([
      { start: 0, end: 10, total: 2, errors: 1 },
      { start: 10, end: 20, total: 2, errors: 1 },
    ]);
  });

  test('puts the upper bound in the last bucket', () => {
    const buckets = bucketByTime([{ at: 20, status: 200 }], 0, 20, 2);
    expect(buckets[1]?.total).toBe(1);
  });

  test('drops events outside the window', () => {
    const buckets = bucketByTime([{ at: -1, status: 200 }, { at: 21, status: 200 }], 0, 20, 2);
    expect(buckets.map((b) => b.total)).toEqual([0, 0]);
  });

  test('never returns fewer than one bucket, even for a degenerate window', () => {
    expect(bucketByTime([{ at: 7, status: 200 }], 7, 7, 0)).toEqual([
      { start: 7, end: 8, total: 1, errors: 0 },
    ]);
  });
});

describe('timeRange', () => {
  test('is null with no usable events', () => {
    expect(timeRange([])).toBe(null);
    expect(timeRange([{ at: Number.NaN, status: 200 }])).toBe(null);
  });

  test('spans min to max inclusive', () => {
    expect(timeRange([{ at: 5, status: 200 }, { at: 1, status: 200 }])).toEqual({ from: 1, to: 6 });
  });
});

describe('scales', () => {
  test('niceMax snaps up to 1/2/5 x 10^n', () => {
    expect(niceMax(1)).toBe(1);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(120)).toBe(200);
    expect(niceMax(0.04)).toBe(0.05);
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-5)).toBe(1);
  });

  test('ticks span zero to max inclusive', () => {
    expect(ticks(100, 4)).toEqual([0, 25, 50, 75, 100]);
    expect(ticks(10, 0)).toEqual([0, 10]);
  });

  test('tickCount keeps every gridline label whole', () => {
    expect(tickCount(100)).toBe(5);
    expect(tickCount(10)).toBe(5);
    expect(tickCount(2)).toBe(2);
    expect(tickCount(1)).toBe(1);
    expect(tickCount(0)).toBe(1);
    for (const max of [1, 2, 5, 10, 20, 50, 100, 200, 500]) {
      for (const tick of ticks(max, tickCount(max))) expect(Number.isInteger(tick)).toBe(true);
    }
  });

  test('scaleLength is clamped to the axis and rounded', () => {
    expect(scaleLength(50, 100, 200)).toBe(100);
    expect(scaleLength(150, 100, 200)).toBe(200);
    expect(scaleLength(-1, 100, 200)).toBe(0);
    expect(scaleLength(1, 0, 200)).toBe(0);
    expect(scaleLength(1, 3, 100)).toBe(33.33);
  });

  test('n2 rounds to two decimals and rejects non-finite input', () => {
    expect(n2(1.005)).toBe(1);
    expect(n2(1.006)).toBe(1.01);
    expect(n2(Number.NaN)).toBe(0);
  });

  test('rate guards division by zero', () => {
    expect(rate(1, 4)).toBe(0.25);
    expect(rate(1, 0)).toBe(0);
  });
});

describe('band', () => {
  test('centres a capped bar in its slot', () => {
    expect(band(0, 4, 400)).toEqual({ x: 38, thickness: 24 });
    expect(band(3, 4, 400)).toEqual({ x: 338, thickness: 24 });
  });

  test('shrinks below the cap when slots are narrow', () => {
    expect(band(0, 10, 100)).toEqual({ x: 1, thickness: 8 });
  });

  test('never produces a zero-width bar', () => {
    expect(band(0, 200, 100).thickness).toBe(1);
  });
});

describe('linePath', () => {
  test('is empty for no points', () => {
    expect(linePath([])).toBe('');
  });

  test('moves to the first point then lines to the rest', () => {
    expect(linePath([{ x: 0, y: 10.005 }, { x: 5.126, y: 0 }])).toBe('M0 10.01 L5.13 0');
  });
});

describe('formatting', () => {
  test('isError is the 4xx/5xx boundary', () => {
    expect(isError(399)).toBe(false);
    expect(isError(400)).toBe(true);
  });

  test('formatClock is UTC', () => {
    expect(formatClock(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('03:04:05');
    expect(formatClock(Number.NaN)).toBe('—');
  });

  test('formatMs switches to seconds above a second', () => {
    expect(formatMs(12.4)).toBe('12 ms');
    expect(formatMs(999)).toBe('999 ms');
    expect(formatMs(1500)).toBe('1.5 s');
  });

  test('seriesColor stays inside the validated palette', () => {
    expect(seriesColor(0)).toBe('#2a78d6');
    expect(seriesColor(4)).toBe('#eb6834');
  });
});
