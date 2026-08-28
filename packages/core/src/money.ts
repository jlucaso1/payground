import { type Result, err, ok } from './result.ts';

declare const brand: unique symbol;

/** An amount in minor units. The domain never holds a decimal amount. */
export type Minor = number & { readonly [brand]: 'Minor' };

export type MoneyError =
  | { kind: 'not_finite' }
  | { kind: 'not_integer' }
  | { kind: 'negative' }
  | { kind: 'too_large' }
  | { kind: 'precision_loss'; exponent: number };

const MAX = Number.MAX_SAFE_INTEGER;

export function minor(value: number): Result<Minor, MoneyError> {
  if (!Number.isFinite(value)) return err({ kind: 'not_finite' });
  if (!Number.isInteger(value)) return err({ kind: 'not_integer' });
  if (value < 0) return err({ kind: 'negative' });
  if (value > MAX) return err({ kind: 'too_large' });
  return ok(value as Minor);
}

export const ZERO = 0 as Minor;

/** Converts a wire amount such as `100.5` into minor units. */
export function fromDecimal(value: number, exponent = 2): Result<Minor, MoneyError> {
  if (!Number.isFinite(value)) return err({ kind: 'not_finite' });
  if (value < 0) return err({ kind: 'negative' });
  const scale = 10 ** exponent;
  const scaled = value * scale;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6) return err({ kind: 'precision_loss', exponent });
  return minor(rounded);
}

export function toDecimal(value: Minor, exponent = 2): number {
  const scale = 10 ** exponent;
  return Math.round(value) / scale;
}

export const add = (a: Minor, b: Minor): Result<Minor, MoneyError> => minor(a + b);
export const subtract = (a: Minor, b: Minor): Result<Minor, MoneyError> => minor(a - b);
export const isZero = (a: Minor): boolean => a === 0;
export const lte = (a: Minor, b: Minor): boolean => a <= b;
