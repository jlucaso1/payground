import { describe, expect, test } from 'bun:test';
import { ManualClock } from '@payground/core/testing.ts';
import { startTestServer } from '../testing.ts';
import { createTokenBucketLimiter, type TokenBucketLimiter } from './index.ts';

function limiter(options: Parameters<typeof createTokenBucketLimiter>[0]): TokenBucketLimiter {
  const created = createTokenBucketLimiter(options);
  if (!created.ok) throw new Error(created.error);
  return created.value;
}

describe('token bucket', () => {
  test('spends the burst and then refuses', () => {
    const clock = new ManualClock(1_000);
    const limits = limiter({ ratePerSecond: 1, burst: 3 });

    for (let i = 0; i < 3; i++) {
      const decision = limits.take('s1', clock.now());
      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(2 - i);
    }
    const refused = limits.take('s1', clock.now());
    expect(refused).toEqual({ allowed: false, remaining: 0, retryAfterMs: 1_000 });
  });

  test('refills at the configured rate', () => {
    const clock = new ManualClock(1_000);
    const limits = limiter({ ratePerSecond: 2, burst: 2 });
    limits.take('s1', clock.now());
    limits.take('s1', clock.now());
    expect(limits.take('s1', clock.now()).allowed).toBe(false);

    clock.advance(500);
    expect(limits.take('s1', clock.now()).allowed).toBe(true);
    expect(limits.take('s1', clock.now()).allowed).toBe(false);

    clock.advance(10_000);
    expect(limits.take('s1', clock.now()).allowed).toBe(true);
    expect(limits.take('s1', clock.now()).allowed).toBe(true);
    // The bucket never fills past the burst.
    expect(limits.take('s1', clock.now()).allowed).toBe(false);
  });

  test('keys are independent', () => {
    const limits = limiter({ ratePerSecond: 1, burst: 1 });
    expect(limits.take('a', 0).allowed).toBe(true);
    expect(limits.take('a', 0).allowed).toBe(false);
    expect(limits.take('b', 0).allowed).toBe(true);
  });

  test('retryAfterMs is never zero when refused', () => {
    const limits = limiter({ ratePerSecond: 1_000, burst: 1 });
    limits.take('a', 0);
    const refused = limits.take('a', 0);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBe(1);
  });

  test('a per-key override replaces the global limit', () => {
    const limits = limiter({ ratePerSecond: 1, burst: 1 });
    expect(limits.setLimit('noisy', { ratePerSecond: 1, burst: 5 }).ok).toBe(true);
    expect(limits.limitFor('noisy')).toEqual({ ratePerSecond: 1, burst: 5 });
    expect(limits.limitFor('quiet')).toEqual({ ratePerSecond: 1, burst: 1 });

    for (let i = 0; i < 5; i++) expect(limits.take('noisy', 0).allowed).toBe(true);
    expect(limits.take('noisy', 0).allowed).toBe(false);
    // The noisy key spending its budget does not touch the others.
    expect(limits.take('quiet', 0).allowed).toBe(true);

    limits.setLimit('noisy', null);
    expect(limits.limitFor('noisy')).toEqual({ ratePerSecond: 1, burst: 1 });
  });

  test('changing an override keeps the spent tokens', () => {
    const limits = limiter({ ratePerSecond: 1, burst: 2 });
    limits.take('noisy', 0);
    limits.take('noisy', 0);
    expect(limits.take('noisy', 0).allowed).toBe(false);
    limits.setLimit('noisy', { ratePerSecond: 1, burst: 1 });
    expect(limits.take('noisy', 0).allowed).toBe(false);
  });

  test('a slow override survives the idle sweep until it has refilled', () => {
    const limits = limiter({ ratePerSecond: 1, burst: 1, idleMs: 1_000 });
    limits.setLimit('slow', { ratePerSecond: 1, burst: 20 });
    limits.take('slow', 0);
    limits.take('other', 0);
    // 'other' refills in a second and goes; 'slow' needs twenty.
    limits.take('probe', 5_000);
    expect(limits.limitFor('slow').burst).toBe(20);
    expect(limits.size).toBe(2);
    limits.take('probe', 30_000);
    expect(limits.size).toBe(1);
  });

  test('rejects an invalid configuration', () => {
    expect(createTokenBucketLimiter({ ratePerSecond: 0, burst: 1 }).ok).toBe(false);
    expect(createTokenBucketLimiter({ ratePerSecond: Number.NaN, burst: 1 }).ok).toBe(false);
    expect(createTokenBucketLimiter({ ratePerSecond: 1, burst: 0 }).ok).toBe(false);
    expect(createTokenBucketLimiter({ ratePerSecond: 1, burst: 1.5 }).ok).toBe(false);
    expect(createTokenBucketLimiter({ ratePerSecond: 1, burst: 1, idleMs: 0 }).ok).toBe(false);
    expect(createTokenBucketLimiter({ ratePerSecond: 1, burst: 1, maxKeys: 0 }).ok).toBe(false);
    const limits = limiter({ ratePerSecond: 1, burst: 1 });
    expect(limits.setLimit('a', { ratePerSecond: -1, burst: 1 })).toMatchObject({ ok: false });
  });

  test('idle keys are evicted', () => {
    const limits = limiter({ ratePerSecond: 1, burst: 1, idleMs: 1_000 });
    limits.take('a', 0);
    limits.take('b', 0);
    expect(limits.size).toBe(2);
    // Only the sweep of a later call drops them; a fresh key rebuilds a full bucket.
    expect(limits.take('c', 5_000).allowed).toBe(true);
    expect(limits.size).toBe(1);
    expect(limits.take('a', 5_000).allowed).toBe(true);
  });

  test('maxKeys bounds the table', () => {
    const limits = limiter({ ratePerSecond: 1, burst: 1, maxKeys: 4 });
    for (let i = 0; i < 100; i++) limits.take(`key-${i}`, 0);
    expect(limits.size).toBe(4);
  });

  test('a backwards clock does not hand out extra tokens', () => {
    const limits = limiter({ ratePerSecond: 1, burst: 2 });
    limits.take('a', 10_000);
    limits.take('a', 10_000);
    expect(limits.take('a', 9_000).allowed).toBe(false);
  });
});

describe('token bucket over http', () => {
  test('answers 429 with a whole-second Retry-After and recovers', async () => {
    const limits = limiter({ ratePerSecond: 2, burst: 2 });
    const app = startTestServer({ rateLimiter: limits });
    try {
      expect((await app.api('GET', '/v1/payments/search')).status).toBe(200);
      expect((await app.api('GET', '/v1/payments/search')).status).toBe(200);

      const refused = await app.api('GET', '/v1/payments/search');
      expect(refused.status).toBe(429);
      expect(refused.body).toMatchObject({ error: 'too_many_requests', status: 429 });
      const retryAfter = refused.headers.get('retry-after');
      expect(retryAfter).toBe('1');

      app.clock.advance(1_000);
      expect((await app.api('GET', '/v1/payments/search')).status).toBe(200);
    } finally {
      await app.stop();
    }
  });

  test('one sandbox cannot starve another', async () => {
    const limits = limiter({ ratePerSecond: 1, burst: 1 });
    const app = startTestServer({ rateLimiter: limits });
    try {
      const created = await app.control('POST', '/_payground/sandboxes', { name: 'other' });
      expect(created.status).toBe(201);
      const other = created.body as { accessToken: string };

      expect((await app.api('GET', '/v1/payments/search')).status).toBe(200);
      expect((await app.api('GET', '/v1/payments/search')).status).toBe(429);
      expect((await app.api('GET', '/v1/payments/search', { token: other.accessToken })).status).toBe(200);
    } finally {
      await app.stop();
    }
  });
});
