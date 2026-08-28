import { type Result, err, ok } from '@payground/core';
import { buildMatrix } from './matrix.ts';
import { ECC_LEVELS, type Ecc, MAX_VERSION, MIN_VERSION, byteCapacity } from './tables.ts';
import { greyscalePng } from './png.ts';

export type { Ecc };

export interface QrOptions {
  ecc?: Ecc;
  scale?: number;
  margin?: number;
}

export type QrError = { kind: 'too_long'; length: number; capacity: number } | { kind: 'invalid_option'; option: string };

const DEFAULT_ECC: Ecc = 'M';
const DEFAULT_SCALE = 4;
const DEFAULT_MARGIN = 4;
const MAX_SCALE = 64;
const MAX_MARGIN = 64;

const encoder = new TextEncoder();

function resolveEcc(ecc: Ecc | undefined): Result<Ecc, QrError> {
  if (ecc === undefined) return ok(DEFAULT_ECC);
  if (!ECC_LEVELS.includes(ecc)) return err({ kind: 'invalid_option', option: 'ecc' });
  return ok(ecc);
}

function resolveCount(value: number | undefined, fallback: number, min: number, max: number, option: string): Result<number, QrError> {
  if (value === undefined) return ok(fallback);
  if (!Number.isInteger(value) || value < min || value > max) return err({ kind: 'invalid_option', option });
  return ok(value);
}

/** Smallest version whose byte-mode capacity fits the payload. */
function selectVersion(byteLength: number, ecc: Ecc): Result<number, QrError> {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    if (byteLength <= byteCapacity(version, ecc)) return ok(version);
  }
  return err({ kind: 'too_long', length: byteLength, capacity: byteCapacity(MAX_VERSION, ecc) });
}

/** Row-major module matrix, true = dark. Exposed for testing. */
export function qrMatrix(text: string, options?: Pick<QrOptions, 'ecc'>): Result<boolean[][], QrError> {
  const ecc = resolveEcc(options?.ecc);
  if (!ecc.ok) return ecc;
  const bytes = encoder.encode(text);
  const version = selectVersion(bytes.length, ecc.value);
  if (!version.ok) return version;
  return ok(buildMatrix(bytes, version.value, ecc.value));
}

/** Black-and-white PNG bytes. */
export function qrPng(text: string, options?: QrOptions): Result<Uint8Array, QrError> {
  const scale = resolveCount(options?.scale, DEFAULT_SCALE, 1, MAX_SCALE, 'scale');
  if (!scale.ok) return scale;
  const margin = resolveCount(options?.margin, DEFAULT_MARGIN, 0, MAX_MARGIN, 'margin');
  if (!margin.ok) return margin;

  const matrix = qrMatrix(text, options?.ecc === undefined ? undefined : { ecc: options.ecc });
  if (!matrix.ok) return matrix;

  const modules = matrix.value.length;
  const side = (modules + margin.value * 2) * scale.value;
  const pixels = new Uint8Array(side * side).fill(0xff);
  for (let y = 0; y < modules; y++) {
    const row = matrix.value[y]!;
    for (let x = 0; x < modules; x++) {
      if (!row[x]) continue;
      const px = (x + margin.value) * scale.value;
      const py = (y + margin.value) * scale.value;
      for (let dy = 0; dy < scale.value; dy++) pixels.fill(0x00, (py + dy) * side + px, (py + dy) * side + px + scale.value);
    }
  }
  return ok(greyscalePng(pixels, side, side));
}

/** Maximum payload in UTF-8 bytes for an error correction level, optionally capped to a version. */
export function qrCapacity(ecc: Ecc = DEFAULT_ECC, version: number = MAX_VERSION): number {
  return byteCapacity(version, ecc);
}
