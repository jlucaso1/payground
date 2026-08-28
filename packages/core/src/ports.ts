/** Epoch milliseconds. Never read the wall clock inside the domain. */
export interface Clock {
  now(): number;
}

export interface IdGenerator {
  uuid(): string;
  /** Monotonic per-scope integer, used for provider-facing resource ids. */
  sequential(scope: string): number;
}

export interface RandomSource {
  int(maxExclusive: number): number;
}
