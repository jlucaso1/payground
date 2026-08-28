import type { Clock, IdGenerator, RandomSource } from './ports.ts';

export class ManualClock implements Clock {
  constructor(private current: number) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(ms: number): void {
    this.current = ms;
  }
}

export class SeededIdGenerator implements IdGenerator {
  private counters = new Map<string, number>();
  private uuidCounter = 0;
  constructor(private seed = 0) {}
  uuid(): string {
    const n = (this.seed + ++this.uuidCounter).toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${n}`;
  }
  sequential(scope: string): number {
    const next = (this.counters.get(scope) ?? this.seed) + 1;
    this.counters.set(scope, next);
    return next;
  }
}

export class SeededRandom implements RandomSource {
  constructor(private state: number = 1) {}
  int(maxExclusive: number): number {
    if (maxExclusive <= 0) throw new Error('maxExclusive must be positive');
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state % maxExclusive;
  }
}
