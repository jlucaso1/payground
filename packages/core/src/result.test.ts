import { describe, expect, test } from 'bun:test';
import { err, flatMap, isErr, isOk, map, ok, unwrap } from './result.ts';

describe('result', () => {
  test('ok carries the value', () => {
    const r = ok(1);
    expect(isOk(r)).toBe(true);
    expect(unwrap(r)).toBe(1);
  });

  test('err carries the error and does not unwrap', () => {
    const r = err('boom');
    expect(isErr(r)).toBe(true);
    expect(() => unwrap(r)).toThrow();
  });

  test('map applies only on ok', () => {
    expect(unwrap(map(ok(2), (n) => n * 3))).toBe(6);
    expect(map(err('e'), () => 1)).toEqual(err('e'));
  });

  test('flatMap chains and short-circuits', () => {
    expect(unwrap(flatMap(ok(2), (n) => ok(n + 1)))).toBe(3);
    expect(flatMap(ok(2), () => err('e'))).toEqual(err('e'));
    expect(flatMap(err('first'), () => err('second'))).toEqual(err('first'));
  });
});
