const ZERO_DECIMAL = new Set(['CLP', 'PYG', 'JPY', 'KRW']);

export function currencyDigits(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

export function formatAmount(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  const negative = minor < 0;
  const abs = Math.abs(Math.trunc(minor)).toString();
  const padded = abs.padStart(digits + 1, '0');
  const whole = digits === 0 ? padded : padded.slice(0, padded.length - digits);
  const frac = digits === 0 ? '' : `.${padded.slice(padded.length - digits)}`;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${currency.toUpperCase()} ${grouped}${frac}`;
}

export function parseAmount(input: string, currency: string): number | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const match = /^(-?)(\d*)(?:[.,](\d*))?$/.exec(trimmed);
  if (match === null) return null;
  const [, sign = '', whole = '', frac = ''] = match;
  if (whole === '' && frac === '') return null;
  const digits = currencyDigits(currency);
  if (frac.length > digits) return null;
  const minor = `${whole === '' ? '0' : whole}${frac.padEnd(digits, '0')}`;
  const value = Number(minor);
  if (!Number.isSafeInteger(value)) return null;
  return sign === '-' ? -value : value;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

export function formatDateTime(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)} ` +
    `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}Z`
  );
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m`;
  if (total < 86400) return `${Math.floor(total / 3600)}h`;
  return `${Math.floor(total / 86400)}d`;
}

export function formatRelative(at: number, now: number): string {
  const delta = now - at;
  if (delta < 0) return `in ${formatDuration(-delta)}`;
  return `${formatDuration(delta)} ago`;
}

export function formatPercent(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}
