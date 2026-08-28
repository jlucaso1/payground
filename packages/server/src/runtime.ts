import type { Clock, IdGenerator, RandomSource } from '@payground/core';

export const systemClock: Clock = { now: () => Date.now() };

export class SystemIdGenerator implements IdGenerator {
  private counters = new Map<string, number>();
  uuid(): string {
    return crypto.randomUUID();
  }
  sequential(scope: string): number {
    const next = (this.counters.get(scope) ?? 0) + 1;
    this.counters.set(scope, next);
    return next;
  }
}

export const systemRandom: RandomSource = {
  int: (maxExclusive) => {
    if (maxExclusive <= 0) throw new Error('maxExclusive must be positive');
    return Math.floor(Math.random() * maxExclusive);
  },
};
