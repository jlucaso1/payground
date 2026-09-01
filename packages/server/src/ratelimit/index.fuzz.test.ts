import { describe, expect, test } from 'bun:test';
import { ManualClock, SeededRandom } from '@payground/core/testing.ts';
import { createTokenBucketLimiter, type RateLimitConfig, type TokenBucketLimiter } from './index.ts';

function limiter(options: Parameters<typeof createTokenBucketLimiter>[0]): TokenBucketLimiter {
  const created = createTokenBucketLimiter(options);
  if (!created.ok) throw new Error(created.error);
  return created.value;
}

/** Floating point refills accumulate error; a thousandth of a token is far below one request. */
const SLACK = 1e-3;

describe('token bucket fuzz', () => {
  test('random request patterns never exceed burst + rate * elapsed', () => {
    const random = new SeededRandom(20260901);

    for (let round = 0; round < 40; round++) {
      const config: RateLimitConfig = { ratePerSecond: 1 + random.int(50), burst: 1 + random.int(20) };
      const limits = limiter(config);
      const clock = new ManualClock(1_700_000_000_000 + random.int(1_000));
      const start = clock.now();
      const keys = ['a', 'b', 'c', 'd'];
      const allowed = new Map<string, number>();

      for (let step = 0; step < 300; step++) {
        clock.advance(random.int(400));
        const key = keys[random.int(keys.length)] as string;
        const decision = limits.take(key, clock.now());
        if (decision.allowed) {
          allowed.set(key, (allowed.get(key) ?? 0) + 1);
          expect(decision.retryAfterMs).toBe(0);
          expect(decision.remaining).toBeGreaterThanOrEqual(0);
          expect(decision.remaining).toBeLessThan(config.burst);
        } else {
          expect(decision.retryAfterMs).toBeGreaterThan(0);
          expect(decision.remaining).toBe(0);
          // Waiting exactly the advertised delay must be enough.
          const later = clock.now() + decision.retryAfterMs;
          expect(limits.take(key, later).allowed).toBe(true);
          clock.set(later);
          allowed.set(key, (allowed.get(key) ?? 0) + 1);
        }

        const elapsed = (clock.now() - start) / 1000;
        for (const count of allowed.values()) {
          expect(count).toBeLessThanOrEqual(config.burst + config.ratePerSecond * elapsed + SLACK);
        }
      }

      // Idle long enough and the bucket is whole again.
      clock.advance(1_000 + Math.ceil((config.burst * 1000) / config.ratePerSecond));
      for (let i = 0; i < config.burst; i++) expect(limits.take('a', clock.now()).allowed).toBe(true);
    }
  });

  test('memory stays bounded across many distinct keys', () => {
    const random = new SeededRandom(20260902);
    const limits = limiter({ ratePerSecond: 5, burst: 5, idleMs: 2_000, maxKeys: 128 });
    const clock = new ManualClock(0);

    for (let step = 0; step < 20_000; step++) {
      clock.advance(random.int(10));
      limits.take(`sandbox-${random.int(50_000)}`, clock.now());
      expect(limits.size).toBeLessThanOrEqual(128);
    }

    // Nothing survives a long silence.
    for (let step = 0; step < 200; step++) {
      clock.advance(10_000);
      limits.take('drain', clock.now());
    }
    expect(limits.size).toBe(1);
  });
});
