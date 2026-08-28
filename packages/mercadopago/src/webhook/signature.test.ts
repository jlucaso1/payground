import { describe, expect, test } from 'bun:test';
import { SeededRandom } from '@payground/core/testing.ts';
import { manifest, sign, signatureHeader } from './signature.ts';

const SECRET = 'payground-secret';
const DATA_ID = '1234567890';
const REQUEST_ID = 'b3a1c0d4-0000-4000-8000-000000000001';
const TS = 1704067200;

describe('manifest', () => {
  test('carries both components', () => {
    expect(manifest({ dataId: DATA_ID, requestId: REQUEST_ID, ts: TS })).toBe(
      'id:1234567890;request-id:b3a1c0d4-0000-4000-8000-000000000001;ts:1704067200;',
    );
  });

  test('omits a missing data id together with its separator', () => {
    expect(manifest({ dataId: null, requestId: REQUEST_ID, ts: TS })).toBe(
      'request-id:b3a1c0d4-0000-4000-8000-000000000001;ts:1704067200;',
    );
  });

  test('omits a missing request id together with its separator', () => {
    expect(manifest({ dataId: DATA_ID, requestId: null, ts: TS })).toBe('id:1234567890;ts:1704067200;');
  });

  test('keeps only the timestamp when both are missing', () => {
    expect(manifest({ dataId: null, requestId: null, ts: TS })).toBe('ts:1704067200;');
  });

  test('blank values count as missing', () => {
    expect(manifest({ dataId: '   ', requestId: '', ts: TS })).toBe('ts:1704067200;');
  });

  test('trims surrounding whitespace like the validator does', () => {
    expect(manifest({ dataId: ' 42 ', requestId: ' req ', ts: TS })).toBe('id:42;request-id:req;ts:1704067200;');
  });

  test('lowercases the data id but not the request id', () => {
    expect(manifest({ dataId: 'ABC-Def', requestId: 'REQ-Id', ts: TS })).toBe(
      'id:abc-def;request-id:REQ-Id;ts:1704067200;',
    );
  });

  test('timestamp is rendered as seconds', () => {
    expect(manifest({ dataId: null, requestId: null, ts: 1 })).toBe('ts:1;');
  });
});

describe('sign', () => {
  test('is stable for a fixed secret', () => {
    expect(sign({ dataId: DATA_ID, requestId: REQUEST_ID, ts: TS, secret: SECRET })).toBe(
      '3b799f1abd395f1e2b2356ac3bb83a1140765b8515ebff57616492cfa9253841',
    );
    expect(sign({ dataId: null, requestId: REQUEST_ID, ts: TS, secret: SECRET })).toBe(
      'c117df15b8639ac0768320fe3c4e78f8295d786fb74933e8c765b167cd0ed9f1',
    );
    expect(sign({ dataId: DATA_ID, requestId: null, ts: TS, secret: SECRET })).toBe(
      '5271f5418f7bcd7e42b4cd1b97d0fbb086d883dd004899279b1e5c344f3715b7',
    );
    expect(sign({ dataId: null, requestId: null, ts: TS, secret: SECRET })).toBe(
      '608de9cd6f2a317809a421440dd02cea623ede25d4dd15bc038df1cdf07a6030',
    );
  });

  test('case of the data id does not change the signature', () => {
    const base = { requestId: REQUEST_ID, ts: TS, secret: SECRET };
    expect(sign({ ...base, dataId: 'ABC-Def' })).toBe(sign({ ...base, dataId: 'abc-def' }));
  });
});

describe('signatureHeader', () => {
  test('is ts first, then v1', () => {
    expect(signatureHeader({ dataId: DATA_ID, requestId: REQUEST_ID, ts: TS, secret: SECRET })).toBe(
      'ts=1704067200,v1=3b799f1abd395f1e2b2356ac3bb83a1140765b8515ebff57616492cfa9253841',
    );
  });

  test('matches the documented shape', () => {
    const header = signatureHeader({ dataId: DATA_ID, requestId: REQUEST_ID, ts: TS, secret: SECRET });
    expect(header).toMatch(/^ts=\d+,v1=[0-9a-f]{64}$/);
  });
});

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789-_';

function text(rng: SeededRandom, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[rng.int(ALPHABET.length)] as string;
  return out;
}

function mutate(rng: SeededRandom, value: string): string {
  const at = rng.int(value.length);
  const current = value[at] as string;
  let replacement = current;
  while (replacement === current) replacement = ALPHABET[rng.int(ALPHABET.length)] as string;
  return value.slice(0, at) + replacement + value.slice(at + 1);
}

function parse(header: string): { ts: string; v1: string } {
  const parsed: Record<string, string> = {};
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    parsed[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  return { ts: parsed['ts'] as string, v1: parsed['v1'] as string };
}

describe('signature fuzz', () => {
  test('headers round-trip and every single-byte change moves the signature', () => {
    const rng = new SeededRandom(20240115);
    for (let i = 0; i < 2000; i++) {
      const input = {
        dataId: text(rng, 1 + rng.int(24)),
        requestId: text(rng, 1 + rng.int(36)),
        ts: 1 + rng.int(2_000_000_000),
        secret: text(rng, 8 + rng.int(56)),
      };
      const expected = sign(input);
      const header = parse(signatureHeader(input));
      expect(header.ts).toBe(String(input.ts));
      expect(header.v1).toBe(expected);
      expect(expected).toMatch(/^[0-9a-f]{64}$/);

      expect(sign({ ...input, dataId: mutate(rng, input.dataId) })).not.toBe(expected);
      expect(sign({ ...input, requestId: mutate(rng, input.requestId) })).not.toBe(expected);
      expect(sign({ ...input, secret: mutate(rng, input.secret) })).not.toBe(expected);
      expect(sign({ ...input, ts: input.ts + 1 })).not.toBe(expected);
      expect(sign({ ...input, dataId: null })).not.toBe(expected);
      expect(sign({ ...input, requestId: null })).not.toBe(expected);
    }
  });

  test('signing is deterministic for the same seed', () => {
    const seeds = [1, 2, 3];
    const run = () =>
      seeds.map((seed) => {
        const rng = new SeededRandom(seed);
        return sign({
          dataId: text(rng, 12),
          requestId: text(rng, 20),
          ts: rng.int(2_000_000_000),
          secret: text(rng, 32),
        });
      });
    expect(run()).toEqual(run());
  });
});
