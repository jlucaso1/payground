/**
 * The API renders timestamps in the collector's local offset, e.g.
 * `2024-01-15T10:30:00.000-03:00` (spec/fixtures3.json). We format against a fixed
 * offset per sandbox rather than UTC so integrators parsing the offset see a realistic value.
 */
export const DEFAULT_OFFSET_MINUTES = -180;

const pad = (value: number, width = 2): string => String(Math.abs(value)).padStart(width, '0');

export function formatDateTime(epochMs: number, offsetMinutes = DEFAULT_OFFSET_MINUTES): string {
  const shifted = new Date(epochMs + offsetMinutes * 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    `.${pad(shifted.getUTCMilliseconds(), 3)}` +
    `${sign}${pad(Math.trunc(offsetMinutes / 60))}:${pad(offsetMinutes % 60)}`
  );
}

export const formatOptional = (
  epochMs: number | null,
  offsetMinutes = DEFAULT_OFFSET_MINUTES,
): string | null => (epochMs === null ? null : formatDateTime(epochMs, offsetMinutes));
