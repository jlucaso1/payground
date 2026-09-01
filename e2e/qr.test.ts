import { describe, expect, test } from 'bun:test';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { unwrap } from '@payground/core';
import { SeededRandom } from '@payground/core/testing.ts';
import { type Ecc, type QrOptions, qrCapacity, qrMatrix, qrPng } from '@payground/mercadopago/qr/index.ts';

const LEVELS: readonly Ecc[] = ['L', 'M', 'Q', 'H'];

/** Encodes with our own code, then decodes with third-party pngjs + jsqr. */
function roundTrip(text: string, options?: QrOptions): string | undefined {
  const png = PNG.sync.read(Buffer.from(unwrap(qrPng(text, options))));
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return decoded?.data;
}

const PIX_BR_CODE =
  '00020126580014BR.GOV.BCB.PIX0136123e4567-e12b-12d1-a456-42665544000052040000530398654051.005802BR5913Payground SA6008SAO PAULO62070503***63041D3D';

describe('qr codes decode with third-party readers', () => {
  test('short ascii at every ecc level', () => {
    for (const ecc of LEVELS) {
      expect(roundTrip('payground', { ecc })).toBe('payground');
    }
  });

  test('a realistic pix br code at every ecc level', () => {
    expect(PIX_BR_CODE.length).toBeGreaterThan(140);
    expect(PIX_BR_CODE.length).toBeLessThan(180);
    for (const ecc of LEVELS) {
      expect(roundTrip(PIX_BR_CODE, { ecc })).toBe(PIX_BR_CODE);
    }
  });

  test('the pix br code fits a small version at the default settings', () => {
    const matrix = unwrap(qrMatrix(PIX_BR_CODE));
    expect((matrix.length - 17) / 4).toBeLessThanOrEqual(15);
    expect(roundTrip(PIX_BR_CODE)).toBe(PIX_BR_CODE);
  });

  test('the maximum supported payload at every ecc level', () => {
    for (const ecc of LEVELS) {
      const text = Array.from({ length: qrCapacity(ecc) }, (_, i) => String.fromCharCode(33 + (i % 94))).join('');
      expect(unwrap(qrMatrix(text, { ecc })).length).toBe(177); // version 40
      expect(roundTrip(text, { ecc })).toBe(text);
    }
  });

  test('unicode payloads survive as utf-8', () => {
    const texts = ['Pagamento de R$ 10,50, José', 'Ação ✓ 日本語 🙂', 'ÀÉÎÕÜ çñ ß', '한국어/中文/العربية'];
    for (const text of texts) {
      for (const ecc of LEVELS) {
        expect(roundTrip(text, { ecc })).toBe(text);
      }
    }
  });

  test('every version from 1 to 40 decodes at every ecc level', () => {
    for (const ecc of LEVELS) {
      for (let version = 1; version <= 40; version++) {
        // jsqr's alignment pattern table has a typo for version 23 (74 instead of 78, breaking its
        // uniform 24-module spacing); it misreads standard-conformant codes there at the weakest ecc.
        if (version === 23 && ecc === 'L') continue;
        const length = qrCapacity(ecc, version);
        const text = Array.from({ length }, (_, i) => String.fromCharCode(33 + (i % 94))).join('');
        expect(unwrap(qrMatrix(text, { ecc })).length).toBe(21 + 4 * (version - 1));
        expect(roundTrip(text, { ecc })).toBe(text);
      }
    }
  }, 120_000);

  test('scale and margin variations still decode', () => {
    for (const options of [{ scale: 2, margin: 4 }, { scale: 8, margin: 4 }, { scale: 4, margin: 8 }, { scale: 3, margin: 2 }] as const) {
      expect(roundTrip(PIX_BR_CODE, options)).toBe(PIX_BR_CODE);
    }
  });

  test('the empty payload decodes to an empty string', () => {
    expect(roundTrip('')).toBe('');
  });

  test('random payloads round-trip', () => {
    const rng = new SeededRandom(7);
    for (let i = 0; i < 120; i++) {
      const ecc = LEVELS[rng.int(LEVELS.length)]!;
      const length = 1 + rng.int(400);
      const text = Array.from({ length }, () => String.fromCharCode(32 + rng.int(95))).join('');
      expect(roundTrip(text, { ecc })).toBe(text);
    }
  });

  test('random unicode payloads round-trip', () => {
    const alphabet = [...'abzAZ09 .-/*áéíóúçãõÀÉÎ日本語한국어✓€-🙂'];
    const rng = new SeededRandom(1234);
    for (let i = 0; i < 60; i++) {
      const ecc = LEVELS[rng.int(LEVELS.length)]!;
      const length = 1 + rng.int(120);
      const text = Array.from({ length }, () => alphabet[rng.int(alphabet.length)]!).join('');
      expect(roundTrip(text, { ecc })).toBe(text);
    }
  });
});
