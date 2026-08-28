import { rsDivisor, rsRemainder } from './galois.ts';
import {
  ECC_FORMAT_BITS,
  type Ecc,
  alignmentPositions,
  byteModeCountBits,
  dataCodewords,
  eccCodewordsPerBlock,
  moduleCount,
  numBlocks,
  totalCodewords,
} from './tables.ts';

const getBit = (value: number, index: number): boolean => ((value >>> index) & 1) !== 0;

/** Mode indicator 0100, character count, then the raw bytes; padded to the version's data capacity. */
export function encodeDataCodewords(bytes: Uint8Array, version: number, ecc: Ecc): Uint8Array {
  const capacityBits = dataCodewords(version, ecc) * 8;
  const bits: boolean[] = [];
  const append = (value: number, width: number): void => {
    for (let i = width - 1; i >= 0; i--) bits.push(getBit(value, i));
  };

  append(0b0100, 4);
  append(bytes.length, byteModeCountBits(version));
  for (const byte of bytes) append(byte, 8);

  for (let i = 0; i < Math.min(4, capacityBits - bits.length); i++) bits.push(false);
  while (bits.length % 8 !== 0) bits.push(false);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) append(pad, 8);

  const result = new Uint8Array(capacityBits / 8);
  bits.forEach((bit, i) => {
    if (bit) result[i >>> 3]! |= 0x80 >>> (i & 7);
  });
  return result;
}

/** Splits data into blocks, appends Reed-Solomon codewords and interleaves them. */
export function addEccAndInterleave(data: Uint8Array, version: number, ecc: Ecc): Uint8Array {
  const blocks = numBlocks(version, ecc);
  const blockEccLen = eccCodewordsPerBlock(version, ecc);
  const rawCodewords = totalCodewords(version);
  const shortBlocks = blocks - (rawCodewords % blocks);
  const shortBlockLen = Math.floor(rawCodewords / blocks);
  const divisor = rsDivisor(blockEccLen);

  const parts: number[][] = [];
  let offset = 0;
  for (let i = 0; i < blocks; i++) {
    const dataLen = shortBlockLen - blockEccLen + (i < shortBlocks ? 0 : 1);
    const chunk = data.subarray(offset, offset + dataLen);
    offset += dataLen;
    const part = [...chunk];
    if (i < shortBlocks) part.push(0); // placeholder, skipped while interleaving
    part.push(...rsRemainder(chunk, divisor));
    parts.push(part);
  }

  const result = new Uint8Array(rawCodewords);
  let k = 0;
  for (let i = 0; i < parts[0]!.length; i++) {
    for (let j = 0; j < parts.length; j++) {
      if (i === shortBlockLen - blockEccLen && j < shortBlocks) continue;
      result[k++] = parts[j]![i]!;
    }
  }
  return result;
}

class Canvas {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly reserved: boolean[][];

  constructor(readonly version: number, readonly ecc: Ecc) {
    this.size = moduleCount(version);
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.reserved[y]![x] = true;
  }

  drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);

    const positions = alignmentPositions(this.version);
    const last = positions.length - 1;
    for (let i = 0; i <= last; i++) {
      for (let j = 0; j <= last; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        this.drawAlignment(positions[i]!, positions[j]!);
      }
    }

    this.drawFormatBits(0);
    this.drawVersionBits();
  }

  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  }

  private drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  drawFormatBits(mask: number): void {
    const value = (ECC_FORMAT_BITS[this.ecc] << 3) | mask;
    let rem = value;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = (((value << 10) | rem) ^ 0x5412) & 0x7fff;

    for (let i = 0; i <= 5; i++) this.setFunction(8, i, getBit(bits, i));
    this.setFunction(8, 7, getBit(bits, 6));
    this.setFunction(8, 8, getBit(bits, 7));
    this.setFunction(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, getBit(bits, i));

    for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, getBit(bits, i));
    this.setFunction(8, this.size - 8, true); // dark module
  }

  private drawVersionBits(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, bit);
      this.setFunction(b, a, bit);
    }
  }

  drawCodewords(codewords: Uint8Array): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.reserved[y]![x] && i < codewords.length * 8) {
            this.modules[y]![x] = getBit(codewords[i >>> 3]!, 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.reserved[y]![x]) continue;
        if (maskAt(mask, x, y)) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  penalty(): number {
    return penaltyScore(this.modules, this.size);
  }
}

function maskAt(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0;
  }
}

const N1 = 3;
const N2 = 3;
const N3 = 40;
const N4 = 10;

function penaltyScore(modules: boolean[][], size: number): number {
  let result = 0;

  const addHistory = (run: number, history: number[]): void => {
    if (history[0] === 0) run += size; // implicit light border before the first run
    history.pop();
    history.unshift(run);
  };
  const countPatterns = (history: number[]): number => {
    const n = history[1]!;
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (core && history[0]! >= n * 4 && history[6]! >= n ? 1 : 0) + (core && history[6]! >= n * 4 && history[0]! >= n ? 1 : 0);
  };
  const terminate = (color: boolean, run: number, history: number[]): number => {
    if (color) {
      addHistory(run, history);
      run = 0;
    }
    addHistory(run + size, history); // implicit light border after the last run
    return countPatterns(history);
  };

  for (let y = 0; y < size; y++) {
    let color = false;
    let run = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let x = 0; x < size; x++) {
      if (modules[y]![x] === color) {
        run++;
        if (run === 5) result += N1;
        else if (run > 5) result++;
      } else {
        addHistory(run, history);
        if (!color) result += countPatterns(history) * N3;
        color = modules[y]![x]!;
        run = 1;
      }
    }
    result += terminate(color, run, history) * N3;
  }

  for (let x = 0; x < size; x++) {
    let color = false;
    let run = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let y = 0; y < size; y++) {
      if (modules[y]![x] === color) {
        run++;
        if (run === 5) result += N1;
        else if (run > 5) result++;
      } else {
        addHistory(run, history);
        if (!color) result += countPatterns(history) * N3;
        color = modules[y]![x]!;
        run = 1;
      }
    }
    result += terminate(color, run, history) * N3;
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const color = modules[y]![x];
      if (color === modules[y]![x + 1] && color === modules[y + 1]![x] && color === modules[y + 1]![x + 1]) result += N2;
    }
  }

  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return result + k * N4;
}

/** Builds the final module matrix, choosing the mask with the lowest penalty. */
export function buildMatrix(bytes: Uint8Array, version: number, ecc: Ecc): boolean[][] {
  const canvas = new Canvas(version, ecc);
  canvas.drawFunctionPatterns();
  canvas.drawCodewords(addEccAndInterleave(encodeDataCodewords(bytes, version, ecc), version, ecc));

  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    canvas.applyMask(mask);
    canvas.drawFormatBits(mask);
    const penalty = canvas.penalty();
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    canvas.applyMask(mask);
  }
  canvas.applyMask(bestMask);
  canvas.drawFormatBits(bestMask);
  return canvas.modules;
}
