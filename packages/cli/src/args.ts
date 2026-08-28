import { parseArgs } from 'node:util';

export const OK = 0;
export const FAILURE = 1;
/** Bad arguments, missing values, unknown commands. */
export const USAGE_ERROR = 2;

export type OptionSpec = Record<string, { type: 'string' | 'boolean'; short?: string }>;
export type Values = Record<string, string | boolean | undefined>;

export type Parsed =
  | { ok: true; values: Values; positionals: readonly string[] }
  | { ok: false; message: string };

export function parseOptions(args: readonly string[], options: OptionSpec, allowPositionals = false): Parsed {
  try {
    const parsed = parseArgs({ args: [...args], options, allowPositionals, strict: true });
    return { ok: true, values: parsed.values as Values, positionals: parsed.positionals };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function flag(values: Values, name: string): boolean {
  return values[name] === true;
}

export function text(values: Values, name: string): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

export type Number_ = { ok: true; value: number } | { ok: false; message: string };

export function integer(raw: string, name: string, min: number, max: number): Number_ {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(value) || value < min || value > max) {
    return { ok: false, message: `--${name} must be an integer between ${min} and ${max}` };
  }
  return { ok: true, value };
}
