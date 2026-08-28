import { describe, expect, test } from 'bun:test';
import { SeededRandom } from '@payground/core/testing.ts';
import { safeFetch, type SafeFetchPolicy } from './index.ts';
import { withRawServer, withServer } from './testing.ts';

const PRIVATE: SafeFetchPolicy = { allowPrivateAddresses: true, maxResponseBytes: 1024 * 1024 };
const NAME_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-';
const VALUE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.,;:/=+@!';

function pick(random: SeededRandom, alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[random.int(alphabet.length)];
  return out;
}

function randomHeaders(random: SeededRandom): Record<string, string> {
  const headers: Record<string, string> = {};
  const count = random.int(9);
  for (let i = 0; i < count; i++) {
    headers[`x-${i}-${pick(random, NAME_CHARS, 1 + random.int(12))}`] = pick(random, VALUE_CHARS, random.int(40));
  }
  return headers;
}

describe('safeFetch fuzz round-trip', () => {
  test('random header sets and body sizes survive the round trip', async () => {
    const random = new SeededRandom(20260828);
    await withServer(
      async (req) => {
        const echoed: Record<string, string> = {};
        for (const [name, value] of req.headers.entries()) if (name.startsWith('x-')) echoed[name] = value;
        return Response.json({ headers: echoed, body: await req.text() });
      },
      async (base) => {
        for (let iteration = 0; iteration < 40; iteration++) {
          const headers = randomHeaders(random);
          const body = pick(random, VALUE_CHARS, random.int(20_000));
          const result = await safeFetch(
            { url: `${base}/hook`, method: 'POST', headers, body, timeoutMs: 5_000 },
            PRIVATE,
          );
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.value.status).toBe(200);
          const echoed = JSON.parse(result.value.body) as { headers: Record<string, string>; body: string };
          expect(echoed.body).toBe(body);
          for (const [name, value] of Object.entries(headers)) expect(echoed.headers[name]).toBe(value);
        }
      },
    );
  });
});

describe('safeFetch fuzz malformed responses', () => {
  test('garbage that is not an HTTP response always yields malformed_response', async () => {
    const random = new SeededRandom(7);
    for (let iteration = 0; iteration < 40; iteration++) {
      const bytes = new Uint8Array(random.int(600));
      for (let i = 0; i < bytes.length; i++) bytes[i] = random.int(256);
      // Guarantee the status line can never parse, so malformed_response is the only correct outcome.
      bytes[0] = 0x51;
      await withRawServer(
        () => bytes,
        async (base) => {
          const result = await safeFetch(
            { url: `${base}/`, method: 'GET', headers: {}, body: null, timeoutMs: 2_000 },
            PRIVATE,
          );
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.kind).toBe('malformed_response');
        },
      );
    }
  });

  test('a valid status line followed by garbage never throws', async () => {
    const random = new SeededRandom(99);
    for (let iteration = 0; iteration < 40; iteration++) {
      const head = new TextEncoder().encode('HTTP/1.1 200 OK\r\n');
      const tail = new Uint8Array(random.int(400));
      for (let i = 0; i < tail.length; i++) tail[i] = random.int(128);
      const bytes = new Uint8Array(head.length + tail.length);
      bytes.set(head, 0);
      bytes.set(tail, head.length);
      await withRawServer(
        () => bytes,
        async (base) => {
          const result = await safeFetch(
            { url: `${base}/`, method: 'GET', headers: {}, body: null, timeoutMs: 2_000 },
            PRIVATE,
          );
          if (result.ok) expect(result.value.status).toBe(200);
          else expect(['malformed_response', 'response_too_large']).toContain(result.error.kind);
        },
      );
    }
  });

  test('random urls never throw and always return a typed result', async () => {
    const random = new SeededRandom(31337);
    const schemes = ['http', 'https', 'ftp', 'file', 'javascript', ''];
    for (let iteration = 0; iteration < 60; iteration++) {
      const scheme = schemes[random.int(schemes.length)] as string;
      const url = `${scheme}${scheme === '' ? '' : '://'}${pick(random, `${NAME_CHARS}.:[]/?&%`, random.int(24))}`;
      const result = await safeFetch(
        { url, method: 'GET', headers: {}, body: null, timeoutMs: 50 },
        { resolve: async () => ['203.0.113.9'] },
      );
      expect(typeof result.ok).toBe('boolean');
      if (!result.ok) {
        expect([
          'invalid_url',
          'unsupported_scheme',
          'dns_failure',
          'blocked_address',
          'timeout',
          'connection_failed',
          'malformed_response',
          'response_too_large',
        ]).toContain(result.error.kind);
      }
    }
  });
});
