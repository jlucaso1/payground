export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;

export function map<T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> {
  return r.ok ? ok(f(r.value)) : r;
}

export function flatMap<T, U, E, F>(r: Result<T, E>, f: (value: T) => Result<U, F>): Result<U, E | F> {
  return r.ok ? f(r.value) : r;
}

export function unwrap<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(`unwrap on error: ${JSON.stringify(r.error)}`);
  return r.value;
}
