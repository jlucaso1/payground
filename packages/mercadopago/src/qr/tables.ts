export type Ecc = 'L' | 'M' | 'Q' | 'H';

export const ECC_LEVELS: readonly Ecc[] = ['L', 'M', 'Q', 'H'];

export const MIN_VERSION = 1;
export const MAX_VERSION = 40;

/** Format-information bits of each error correction level (ISO/IEC 18004 table 12). */
export const ECC_FORMAT_BITS: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** ISO/IEC 18004 table 13-22: error correction codewords per block, indexed by version. */
const ECC_CODEWORDS_PER_BLOCK: Record<Ecc, readonly number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

/** ISO/IEC 18004 table 13-22: number of error correction blocks, indexed by version. */
const NUM_BLOCKS: Record<Ecc, readonly number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

export const eccCodewordsPerBlock = (version: number, ecc: Ecc): number => ECC_CODEWORDS_PER_BLOCK[ecc][version]!;
export const numBlocks = (version: number, ecc: Ecc): number => NUM_BLOCKS[ecc][version]!;

export const moduleCount = (version: number): number => version * 4 + 17;

/** Number of data + error correction modules, i.e. everything but function patterns and format/version info. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

export const totalCodewords = (version: number): number => Math.floor(rawDataModules(version) / 8);

export function dataCodewords(version: number, ecc: Ecc): number {
  return totalCodewords(version) - eccCodewordsPerBlock(version, ecc) * numBlocks(version, ecc);
}

/** Character count indicator width for byte mode (ISO/IEC 18004 table 3). */
export const byteModeCountBits = (version: number): number => (version <= 9 ? 8 : 16);

/** Largest byte-mode payload that fits a version, in bytes. */
export function byteCapacity(version: number, ecc: Ecc): number {
  return Math.floor((dataCodewords(version, ecc) * 8 - 4 - byteModeCountBits(version)) / 8);
}

/** Centre coordinates of the alignment patterns (ISO/IEC 18004 annex E). */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = moduleCount(version) - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}
