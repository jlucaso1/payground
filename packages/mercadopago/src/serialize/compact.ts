export type Loose<T> = { [K in keyof T]?: T[K] | undefined };

/**
 * The generated types use `prop?: T` and the project runs with exactOptionalPropertyTypes,
 * so an explicit `undefined` is not assignable. Building loosely and dropping the undefined
 * keys here keeps the serializers readable and confines the cast to one place.
 */
export function compact<T extends object>(value: Loose<T>): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}
