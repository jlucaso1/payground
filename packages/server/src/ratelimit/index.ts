import { type RateLimitDecision, type RateLimiter, type Result, err, ok } from '@payground/core';

export interface RateLimitConfig {
  /** Sustained requests per second. */
  readonly ratePerSecond: number;
  /** Bucket depth: how many requests may be spent at once. */
  readonly burst: number;
}

export interface TokenBucketOptions extends RateLimitConfig {
  /**
   * Buckets untouched for this long are dropped. A key is only swept once it has also had
   * time to refill, so dropping it hands out nothing it had not earned back.
   */
  readonly idleMs?: number;
  /**
   * Hard cap on tracked keys; the least recently used go first. This one is a real bound
   * rather than a lossless sweep: an evicted key restarts with a full bucket, so keep it
   * comfortably above the number of sandboxes that are active at once.
   */
  readonly maxKeys?: number;
}

export interface TokenBucketLimiter extends RateLimiter {
  /** Per-key limit; null restores the global one. */
  setLimit(key: string, config: RateLimitConfig | null): Result<null, string>;
  limitFor(key: string): RateLimitConfig;
  readonly size: number;
}

const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_MAX_KEYS = 10_000;
/** Caps the work a single call does on the eviction queue. */
const SWEEP_BUDGET = 64;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const refillMs = (config: RateLimitConfig): number => Math.ceil((config.burst * 1000) / config.ratePerSecond);

export function validateRateLimit(config: RateLimitConfig): Result<RateLimitConfig, string> {
  if (!Number.isFinite(config.ratePerSecond) || config.ratePerSecond <= 0) {
    return err('the rate must be a positive number of requests per second');
  }
  if (!Number.isInteger(config.burst) || config.burst < 1) return err('the burst must be an integer of at least 1');
  return ok(config);
}

class TokenBucket implements TokenBucketLimiter {
  /** Insertion order doubles as the LRU queue: a touched key is re-inserted at the tail. */
  private readonly buckets = new Map<string, Bucket>();
  private readonly overrides = new Map<string, RateLimitConfig>();

  constructor(
    private readonly global: RateLimitConfig,
    private readonly maxKeys: number,
    private readonly idleMs: number,
  ) {}

  get size(): number {
    return this.buckets.size;
  }

  limitFor(key: string): RateLimitConfig {
    return this.overrides.get(key) ?? this.global;
  }

  setLimit(key: string, config: RateLimitConfig | null): Result<null, string> {
    if (config === null) {
      this.overrides.delete(key);
    } else {
      const valid = validateRateLimit(config);
      if (!valid.ok) return valid;
      this.overrides.set(key, { ratePerSecond: config.ratePerSecond, burst: config.burst });
    }
    // The bucket survives the change, clamped to the new depth: retuning a noisy key must
    // not reward it with a fresh burst.
    const bucket = this.buckets.get(key);
    if (bucket !== undefined) bucket.tokens = Math.min(bucket.tokens, this.limitFor(key).burst);
    return ok(null);
  }

  take(key: string, now: number): RateLimitDecision {
    this.sweep(now);
    const config = this.limitFor(key);
    const existing = this.buckets.get(key);
    const bucket = existing ?? { tokens: config.burst, updatedAt: now };
    if (existing !== undefined) {
      this.buckets.delete(key);
      const elapsed = Math.max(0, now - bucket.updatedAt);
      bucket.tokens = Math.min(config.burst, bucket.tokens + (elapsed * config.ratePerSecond) / 1000);
    }
    bucket.updatedAt = now;
    this.buckets.set(key, bucket);
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next();
      if (oldest.done === true) break;
      this.buckets.delete(oldest.value);
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }
    const retryAfterMs = Math.ceil(((1 - bucket.tokens) * 1000) / config.ratePerSecond);
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, retryAfterMs) };
  }

  private sweep(now: number): void {
    let scanned = 0;
    for (const [key, bucket] of this.buckets) {
      // The map is ordered by last touch, so the first key too young to sweep ends the scan.
      if (now - bucket.updatedAt < this.idleMs) break;
      if (++scanned > SWEEP_BUDGET) break;
      // A key with a slow override may need longer than idleMs to look untouched.
      if (now - bucket.updatedAt < refillMs(this.limitFor(key))) continue;
      this.buckets.delete(key);
    }
  }
}

export function createTokenBucketLimiter(options: TokenBucketOptions): Result<TokenBucketLimiter, string> {
  const valid = validateRateLimit(options);
  if (!valid.ok) return valid;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  if (!Number.isFinite(idleMs) || idleMs <= 0) return err('idleMs must be a positive number of milliseconds');
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  if (!Number.isInteger(maxKeys) || maxKeys < 1) return err('maxKeys must be an integer of at least 1');
  return ok(
    new TokenBucket({ ratePerSecond: options.ratePerSecond, burst: options.burst }, maxKeys, idleMs),
  );
}
