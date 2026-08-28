import { describe, expect, test } from 'bun:test';
import { ManualClock, SeededIdGenerator, SeededRandom } from './testing.ts';

describe('testing doubles', () => {
  test('clock only moves when advanced', () => {
    const clock = new ManualClock(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
    clock.set(0);
    expect(clock.now()).toBe(0);
  });

  test('ids are deterministic per seed', () => {
    const a = new SeededIdGenerator(0);
    const b = new SeededIdGenerator(0);
    expect(a.uuid()).toBe(b.uuid());
    expect(a.sequential('payment')).toBe(b.sequential('payment'));
    expect(a.sequential('payment')).toBe(2);
    expect(a.sequential('refund')).toBe(1);
  });

  test('uuids are unique and well formed', () => {
    const gen = new SeededIdGenerator();
    const seen = new Set(Array.from({ length: 1000 }, () => gen.uuid()));
    expect(seen.size).toBe(1000);
    for (const id of seen) expect(id).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  });

  test('random stays in range and is reproducible', () => {
    const a = new SeededRandom(7);
    const b = new SeededRandom(7);
    for (let i = 0; i < 500; i++) {
      const v = a.int(10);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(10);
      expect(v).toBe(b.int(10));
    }
    expect(() => a.int(0)).toThrow();
  });
});
