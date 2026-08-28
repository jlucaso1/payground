import { type Result, err, ok } from '@payground/core';

export interface BoletoInput {
  bankCode: string;
  currencyCode?: string;
  amount: number;
  dueDate: Date | null;
  freeField: string;
}

export type BoletoError =
  | { kind: 'invalid_field'; field: string; reason: string }
  | { kind: 'amount_out_of_range'; amount: number };

/** Factor base date defined by FEBRABAN ("Layout Padrao de Codigo de Barras", data base 07/10/1997). */
export const FACTOR_EPOCH_UTC = Date.UTC(1997, 9, 7);
const DAY_MS = 86_400_000;
/** Factors below 1000 were never issued; 03/07/2000 is the first day in use (factor 1000). */
export const FACTOR_MIN = 1000;
export const FACTOR_MAX = 9999;
/** Cycle length of the rollover: 9999 (21/02/2025) is followed by 1000 (22/02/2025). */
const FACTOR_CYCLE = FACTOR_MAX - FACTOR_MIN + 1;

export const MAX_CENTS = 9_999_999_999;

const DIGITS = /^\d+$/;

function fieldErr(field: string, reason: string): Result<never, BoletoError> {
  return err({ kind: 'invalid_field', field, reason });
}

/**
 * Luhn-style modulo 10 used by the linha digitavel fields 1-3: weights 2,1,2,1... from right to
 * left, products above 9 have their digits summed.
 */
export function modulo10(digits: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    const product = Number(digits[i]) * weight;
    sum += product > 9 ? product - 9 : product;
    weight = weight === 2 ? 1 : 2;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Modulo 11 used for the barcode check digit: weights 2..9 cycling from right to left; a resulting
 * digit of 0, 10 or 11 (i.e. remainder 0, 1 or 10) is replaced by 1.
 */
export function modulo11(digits: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const digit = 11 - (sum % 11);
  return digit === 0 || digit === 10 || digit === 11 ? 1 : digit;
}

export function dueDateFactor(dueDate: Date | null): Result<string, BoletoError> {
  if (dueDate === null) return ok('0000');
  const time = dueDate.getTime();
  if (!Number.isFinite(time)) return fieldErr('dueDate', 'invalid date');
  // Truncate to the UTC calendar day so the factor never depends on the host timezone.
  const day = Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate());
  const raw = Math.round((day - FACTOR_EPOCH_UTC) / DAY_MS);
  if (raw < FACTOR_MIN) return fieldErr('dueDate', 'before 2000-07-03, the first factor in use');
  return ok(String(((raw - FACTOR_MIN) % FACTOR_CYCLE) + FACTOR_MIN).padStart(4, '0'));
}

function amountCents(amount: number): Result<string, BoletoError> {
  if (!Number.isFinite(amount) || amount < 0) return err({ kind: 'amount_out_of_range', amount });
  const cents = Math.round(amount * 100);
  if (Math.abs(amount * 100 - cents) > 1e-6) return fieldErr('amount', 'more than two decimal places');
  if (cents > MAX_CENTS) return err({ kind: 'amount_out_of_range', amount });
  return ok(String(cents).padStart(10, '0'));
}

export function barcode(input: BoletoInput): Result<string, BoletoError> {
  if (!/^\d{3}$/.test(input.bankCode)) return fieldErr('bankCode', 'expected 3 digits');
  const currency = input.currencyCode ?? '9';
  if (!/^\d$/.test(currency)) return fieldErr('currencyCode', 'expected 1 digit');
  if (!/^\d{25}$/.test(input.freeField)) return fieldErr('freeField', 'expected 25 digits');

  const factor = dueDateFactor(input.dueDate);
  if (!factor.ok) return factor;
  const cents = amountCents(input.amount);
  if (!cents.ok) return cents;

  const withoutDv = input.bankCode + currency + factor.value + cents.value + input.freeField;
  const dv = modulo11(withoutDv);
  return ok(`${withoutDv.slice(0, 4)}${dv}${withoutDv.slice(4)}`);
}

function checkBarcode(barcode44: string): Result<string, BoletoError> {
  if (!/^\d{44}$/.test(barcode44)) return fieldErr('barcode', 'expected 44 digits');
  const expected = modulo11(barcode44.slice(0, 4) + barcode44.slice(5));
  if (Number(barcode44[4]) !== expected) {
    return fieldErr('barcode', `check digit ${barcode44[4]} should be ${expected}`);
  }
  return ok(barcode44);
}

/**
 * Field layout: 1 = bank+currency+free[1..5], 2 = free[6..15], 3 = free[16..25], each closed by a
 * modulo 10 digit; 4 = the barcode check digit; 5 = factor + amount.
 */
export function linhaDigitavel(barcode44: string): Result<string, BoletoError> {
  const checked = checkBarcode(barcode44);
  if (!checked.ok) return checked;
  const bar = checked.value;
  const free = bar.slice(19);

  const one = bar.slice(0, 4) + free.slice(0, 5);
  const two = free.slice(5, 15);
  const three = free.slice(15, 25);
  const f1 = one + modulo10(one);
  const f2 = two + modulo10(two);
  const f3 = three + modulo10(three);

  return ok(
    `${f1.slice(0, 5)}.${f1.slice(5)} ${f2.slice(0, 5)}.${f2.slice(5)} ${f3.slice(0, 5)}.${f3.slice(5)} ${bar[4]} ${bar.slice(5, 19)}`,
  );
}

export function parseLinhaDigitavel(line: string): Result<string, BoletoError> {
  const digits = line.replace(/[ .]/g, '');
  if (digits.length !== 47 || !DIGITS.test(digits)) return fieldErr('line', 'expected 47 digits');

  const fields = [digits.slice(0, 10), digits.slice(10, 21), digits.slice(21, 32)];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as string;
    const body = field.slice(0, -1);
    const expected = modulo10(body);
    if (Number(field.slice(-1)) !== expected) {
      return fieldErr(`field${i + 1}`, `check digit ${field.slice(-1)} should be ${expected}`);
    }
  }

  const bankAndCurrency = digits.slice(0, 4);
  const dv = digits[32] as string;
  const factorAndAmount = digits.slice(33, 47);
  const free = digits.slice(4, 9) + digits.slice(10, 20) + digits.slice(21, 31);
  return checkBarcode(bankAndCurrency + dv + factorAndAmount + free);
}
