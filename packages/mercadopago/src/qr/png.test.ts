import { describe, expect, test } from 'bun:test';
import { unwrap } from '@payground/core';
import { type Ecc, type QrOptions, qrCapacity, qrMatrix, qrPng } from './index.ts';
import { PNG_SIGNATURE, crc32 } from './png.ts';

interface Chunk {
  readonly type: string;
  readonly data: Uint8Array;
  readonly crcValid: boolean;
}

function readChunks(png: Uint8Array): Chunk[] {
  expect([...png.subarray(0, 8)]).toEqual([...PNG_SIGNATURE]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Chunk[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    const crc = view.getUint32(offset + 8 + length);
    chunks.push({ type, data, crcValid: crc32(png.subarray(offset + 4, offset + 8 + length)) === crc });
    offset += 12 + length;
  }
  expect(offset).toBe(png.length);
  return chunks;
}

const ihdrOf = (png: Uint8Array): { width: number; height: number; depth: number; colorType: number } => {
  const ihdr = readChunks(png)[0]!;
  expect(ihdr.type).toBe('IHDR');
  const view = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
  return { width: view.getUint32(0), height: view.getUint32(4), depth: ihdr.data[8]!, colorType: ihdr.data[9]! };
};

/** Reverses the PNG filtering (always "none" here) back to a greyscale pixel grid. */
function readPixels(png: Uint8Array): { width: number; height: number; at: (x: number, y: number) => number } {
  const { width, height } = ihdrOf(png);
  const idat = readChunks(png).filter((c) => c.type === 'IDAT');
  expect(idat.length).toBe(1);
  const zlibStream = idat[0]!.data;
  const raw = Bun.inflateSync(zlibStream.slice(2, zlibStream.length - 4));
  expect(raw.length).toBe((width + 1) * height);
  for (let y = 0; y < height; y++) expect(raw[y * (width + 1)]).toBe(0);
  return { width, height, at: (x, y) => raw[y * (width + 1) + 1 + x]! };
}

describe('crc32', () => {
  test('matches the known PNG/zlib test vectors', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082);
  });
});

describe('qrPng', () => {
  test('emits signature, IHDR, IDAT and IEND with valid CRCs', () => {
    const png = unwrap(qrPng('structure'));
    const chunks = readChunks(png);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    for (const chunk of chunks) expect(chunk.crcValid).toBe(true);
    expect(chunks.at(-1)!.data.length).toBe(0);
  });

  test('a corrupted byte invalidates the chunk CRC', () => {
    const png = unwrap(qrPng('structure'));
    png[30] = png[30]! ^ 0xff;
    expect(readChunks(png).some((c) => !c.crcValid)).toBe(true);
  });

  test('IHDR describes an 8-bit greyscale square of (modules + 2 * margin) * scale', () => {
    const cases: readonly QrOptions[] = [{}, { scale: 1, margin: 0 }, { scale: 7, margin: 2 }, { ecc: 'H', scale: 3, margin: 10 }];
    for (const options of cases) {
      const png = unwrap(qrPng('sizing test', options));
      const modules = unwrap(qrMatrix('sizing test', options.ecc === undefined ? undefined : { ecc: options.ecc })).length;
      const side = (modules + (options.margin ?? 4) * 2) * (options.scale ?? 4);
      expect(ihdrOf(png)).toEqual({ width: side, height: side, depth: 8, colorType: 0 });
    }
  });

  test('renders the quiet zone as light pixels and mirrors the matrix', () => {
    const scale = 3;
    const margin = 4;
    const text = 'quiet zone';
    const matrix = unwrap(qrMatrix(text));
    const { width, at } = readPixels(unwrap(qrPng(text, { scale, margin })));

    for (let i = 0; i < width; i++) {
      for (let b = 0; b < margin * scale; b++) {
        expect(at(i, b)).toBe(0xff);
        expect(at(i, width - 1 - b)).toBe(0xff);
        expect(at(b, i)).toBe(0xff);
        expect(at(width - 1 - b, i)).toBe(0xff);
      }
    }

    for (let y = 0; y < matrix.length; y++) {
      for (let x = 0; x < matrix.length; x++) {
        const expected = matrix[y]![x] ? 0x00 : 0xff;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            expect(at((x + margin) * scale + dx, (y + margin) * scale + dy)).toBe(expected);
          }
        }
      }
    }
  });

  test('a zero margin leaves no quiet zone', () => {
    const matrix = unwrap(qrMatrix('no margin'));
    const { width, at } = readPixels(unwrap(qrPng('no margin', { scale: 1, margin: 0 })));
    expect(width).toBe(matrix.length);
    expect(at(0, 0)).toBe(0x00);
  });

  test('is byte-for-byte deterministic', () => {
    for (const ecc of ['L', 'M', 'Q', 'H'] as const) {
      const a = unwrap(qrPng('deterministic', { ecc }));
      const b = unwrap(qrPng('deterministic', { ecc }));
      expect([...a]).toEqual([...b]);
    }
  });

  test('propagates too_long from the matrix builder', () => {
    const capacity = qrCapacity('L');
    const result = qrPng('a'.repeat(capacity + 1), { ecc: 'L' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual({ kind: 'too_long', length: capacity + 1, capacity });
  });

  test('rejects invalid options', () => {
    const invalid: readonly [QrOptions, string][] = [
      [{ scale: 0 }, 'scale'],
      [{ scale: -1 }, 'scale'],
      [{ scale: 1.5 }, 'scale'],
      [{ scale: Number.NaN }, 'scale'],
      [{ scale: 65 }, 'scale'],
      [{ margin: -1 }, 'margin'],
      [{ margin: 0.5 }, 'margin'],
      [{ margin: 65 }, 'margin'],
      [{ ecc: 'X' as Ecc }, 'ecc'],
    ];
    for (const [options, option] of invalid) {
      const result = qrPng('x', options);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_option', option });
    }
  });
});
