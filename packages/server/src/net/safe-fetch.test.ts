import { describe, expect, test } from 'bun:test';
import { safeFetch, type SafeFetchPolicy, type SafeRequest } from './index.ts';
import { withRawServer, withServer } from './testing.ts';

const PRIVATE: SafeFetchPolicy = { allowPrivateAddresses: true };

function request(url: string, overrides: Partial<SafeRequest> = {}): SafeRequest {
  return { url, method: 'GET', headers: {}, body: null, timeoutMs: 2_000, ...overrides };
}

describe('safeFetch validation', () => {
  test('rejects a malformed url', async () => {
    const result = await safeFetch(request('http://'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_url');
  });

  test('rejects a non-http scheme', async () => {
    const result = await safeFetch(request('ftp://example.com/x'));
    expect(result).toEqual({ ok: false, error: { kind: 'unsupported_scheme', scheme: 'ftp' } });
  });

  test('rejects a method that is not a token', async () => {
    const result = await safeFetch(request('http://example.com/', { method: 'GET /admin HTTP/1.1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_url');
  });

  test('literal private ip is refused without any dns lookup', async () => {
    let resolved = false;
    const result = await safeFetch(request('http://127.0.0.1:1/'), {
      resolve: async () => {
        resolved = true;
        return ['8.8.8.8'];
      },
    });
    expect(resolved).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('blocked_address');
      if (result.error.kind === 'blocked_address') expect(result.error.address).toBe('127.0.0.1');
    }
  });

  test('ipv4-mapped ipv6 literal is refused', async () => {
    const result = await safeFetch(request('http://[::ffff:169.254.169.254]/latest/meta-data'));
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'blocked_address') {
      expect(result.error.reason).toContain('ipv4-mapped');
    } else {
      expect.unreachable();
    }
  });

  test('a hostname resolving to public and private records is refused entirely', async () => {
    const result = await safeFetch(request('http://rebind.test/hook'), {
      resolve: async () => ['93.184.216.34', '127.0.0.1'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'blocked_address') {
      expect(result.error.hostname).toBe('rebind.test');
      expect(result.error.address).toBe('127.0.0.1');
      expect(result.error.reason).toContain('loopback');
    } else {
      expect.unreachable();
    }
  });

  test('a hostname resolving only to public records passes validation', async () => {
    const result = await safeFetch(request('http://public.test/hook', { timeoutMs: 400 }), {
      resolve: async () => ['203.0.113.5'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(['timeout', 'connection_failed']).toContain(result.error.kind);
  });

  test('dns errors and empty answers become dns_failure', async () => {
    const thrown = await safeFetch(request('http://broken.test/'), {
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(thrown).toEqual({ ok: false, error: { kind: 'dns_failure', hostname: 'broken.test', message: 'ENOTFOUND' } });

    const empty = await safeFetch(request('http://empty.test/'), { resolve: async () => [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.kind).toBe('dns_failure');
  });

  test('allowlisted hostnames may resolve to private addresses', async () => {
    await withServer(
      (req) => new Response(req.headers.get('host') ?? ''),
      async (_base, port) => {
        const result = await safeFetch(request(`http://webhook.test:${port}/hook`), {
          allowlist: ['WEBHOOK.test'],
          resolve: async () => ['127.0.0.1'],
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.body).toBe(`webhook.test:${port}`);
          expect(result.value.address).toBe('127.0.0.1');
        }
      },
    );
  });
});

describe('safeFetch over the wire', () => {
  test('returns status, reason phrase, headers and body', async () => {
    await withServer(
      () => new Response('pong', { status: 201, statusText: 'Created', headers: { 'x-custom': 'yes' } }),
      async (base) => {
        const result = await safeFetch(request(`${base}/ping?a=1`), PRIVATE);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.status).toBe(201);
        expect(result.value.statusText).toBe('Created');
        expect(result.value.headers['x-custom']).toBe('yes');
        expect(result.value.headers['content-length']).toBe('4');
        expect(result.value.body).toBe('pong');
        expect(result.value.address).toBe('127.0.0.1');
        expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
      },
    );
  });

  test('sends the query string and path unchanged', async () => {
    await withServer(
      (req) => new Response(new URL(req.url).pathname + new URL(req.url).search),
      async (base) => {
        const result = await safeFetch(request(`${base}/a/b?x=1&y=2`), PRIVATE);
        expect(result.ok && result.value.body).toBe('/a/b?x=1&y=2');
      },
    );
  });

  test('posts headers and body intact', async () => {
    await withServer(
      async (req) => new Response(`${req.method}:${req.headers.get('x-signature') ?? ''}:${await req.text()}`),
      async (base) => {
        const body = JSON.stringify({ id: 1, note: 'ação-ünïcode' });
        const result = await safeFetch(
          request(`${base}/hook`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-signature': 'abc123' },
            body,
          }),
          PRIVATE,
        );
        expect(result.ok && result.value.body).toBe(`POST:abc123:${body}`);
      },
    );
  });

  test('decodes chunked responses', async () => {
    await withServer(
      () =>
        new Response(
          new ReadableStream({
            // Yielding between writes is what makes Bun emit real chunked framing instead of buffering.
            async start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode('chunk-one;'));
              await Bun.sleep(1);
              controller.enqueue(encoder.encode('chunk-two;'));
              await Bun.sleep(1);
              controller.enqueue(encoder.encode('chunk-three'));
              controller.close();
            },
          }),
        ),
      async (base) => {
        const result = await safeFetch(request(`${base}/stream`), PRIVATE);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.headers['transfer-encoding']).toBe('chunked');
        expect(result.value.body).toBe('chunk-one;chunk-two;chunk-three');
      },
    );
  });

  test('decodes chunked responses with extensions and trailers', async () => {
    const raw =
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTrailer: X-Sum\r\n\r\n' +
      '5;ext=1\r\nhello\r\n' +
      '1\r\n \r\n' +
      '5\r\nworld\r\n' +
      '0\r\nX-Sum: 11\r\n\r\n';
    await withRawServer(
      () => raw,
      async (base) => {
        const result = await safeFetch(request(`${base}/`), PRIVATE);
        expect(result.ok && result.value.body).toBe('hello world');
      },
    );
  });

  test('joins duplicated headers and unfolds obs-fold values', async () => {
    const raw =
      'HTTP/1.1 200 OK\r\nX-Multi: a\r\nX-Multi: b\r\nX-Folded: start\r\n   continued\r\nContent-Length: 2\r\n\r\nhi';
    await withRawServer(
      () => raw,
      async (base) => {
        const result = await safeFetch(request(`${base}/`), PRIVATE);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.headers['x-multi']).toBe('a, b');
        expect(result.value.headers['x-folded']).toBe('start continued');
        expect(result.value.body).toBe('hi');
      },
    );
  });

  test('does not follow redirects', async () => {
    let hits = 0;
    await withServer(
      (req) => {
        hits++;
        if (new URL(req.url).pathname === '/from') {
          return new Response(null, { status: 302, headers: { location: '/to' } });
        }
        return new Response('followed');
      },
      async (base) => {
        const result = await safeFetch(request(`${base}/from`), PRIVATE);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.status).toBe(302);
        expect(result.value.headers['location']).toBe('/to');
        expect(result.value.body).toBe('');
        expect(hits).toBe(1);
      },
    );
  });

  test('bodies over the limit fail with response_too_large', async () => {
    await withServer(
      () => new Response('x'.repeat(200_000)),
      async (base) => {
        const result = await safeFetch(request(`${base}/big`), { allowPrivateAddresses: true, maxResponseBytes: 4096 });
        expect(result).toEqual({ ok: false, error: { kind: 'response_too_large', limit: 4096 } });
      },
    );
  });

  test('oversized chunked bodies fail with response_too_large', async () => {
    await withServer(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder();
              for (let i = 0; i < 40; i++) {
                controller.enqueue(encoder.encode('y'.repeat(1024)));
                await Bun.sleep(1);
              }
              controller.close();
            },
          }),
        ),
      async (base) => {
        const result = await safeFetch(request(`${base}/big`), { allowPrivateAddresses: true, maxResponseBytes: 4096 });
        expect(result).toEqual({ ok: false, error: { kind: 'response_too_large', limit: 4096 } });
      },
    );
  });

  test('a body just under the limit still succeeds', async () => {
    await withServer(
      () => new Response('z'.repeat(1000)),
      async (base) => {
        const result = await safeFetch(request(`${base}/ok`), { allowPrivateAddresses: true, maxResponseBytes: 65_536 });
        expect(result.ok && result.value.body.length).toBe(1000);
      },
    );
  });

  test('a slow handler hits the timeout', async () => {
    await withServer(
      async () => {
        await Bun.sleep(500);
        return new Response('late');
      },
      async (base) => {
        const result = await safeFetch(request(`${base}/slow`, { timeoutMs: 60 }), PRIVATE);
        expect(result).toEqual({ ok: false, error: { kind: 'timeout', timeoutMs: 60 } });
      },
    );
  });

  test('a refused connection reports connection_failed', async () => {
    const listener = Bun.listen<undefined>({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    const port = listener.port;
    listener.stop(true);
    const result = await safeFetch(request(`http://127.0.0.1:${port}/`, { timeoutMs: 1_000 }), PRIVATE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(['connection_failed', 'timeout']).toContain(result.error.kind);
  });

  test('durationMs comes from the injected clock', async () => {
    await withServer(
      () => new Response('ok'),
      async (base) => {
        let current = 1_000;
        const result = await safeFetch(request(`${base}/`), {
          allowPrivateAddresses: true,
          now: () => {
            current += 25;
            return current;
          },
        });
        expect(result.ok && result.value.durationMs).toBe(25);
      },
    );
  });
});

describe('safeFetch malformed responses', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['garbage', 'NOT-HTTP AT ALL\r\n\r\nbody'],
    ['bad version', 'HTTP/9.9 200 OK\r\nContent-Length: 0\r\n\r\n'],
    ['non numeric status', 'HTTP/1.1 abc OK\r\nContent-Length: 0\r\n\r\n'],
    ['header without colon', 'HTTP/1.1 200 OK\r\nbroken-header\r\n\r\n'],
    ['invalid header name', 'HTTP/1.1 200 OK\r\nbad header: x\r\nContent-Length: 0\r\n\r\n'],
    ['negative content-length', 'HTTP/1.1 200 OK\r\nContent-Length: -5\r\n\r\n'],
    ['conflicting content-length', 'HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nx'],
    ['smuggling framing', 'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n'],
    ['unknown transfer-encoding', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\nxx'],
    ['truncated body', 'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort'],
    ['bad chunk size', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZZ\r\nhello\r\n0\r\n\r\n'],
    ['chunk missing crlf', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhelloXX0\r\n\r\n'],
    ['truncated chunked', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n'],
    ['empty response', ''],
    ['leading fold', 'HTTP/1.1 200 OK\r\n  folded\r\n\r\n'],
  ];

  for (const [name, raw] of cases) {
    test(`${name} yields malformed_response`, async () => {
      await withRawServer(
        () => raw,
        async (base) => {
          const result = await safeFetch(request(`${base}/`, { timeoutMs: 1_000 }), PRIVATE);
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.kind).toBe('malformed_response');
        },
      );
    });
  }

  test('a body framed by connection close is accepted', async () => {
    await withRawServer(
      () => 'HTTP/1.1 200 OK\r\nX-Kind: close-framed\r\n\r\nno length here',
      async (base) => {
        const result = await safeFetch(request(`${base}/`), PRIVATE);
        expect(result.ok && result.value.body).toBe('no length here');
      },
    );
  });

  test('204 responses carry no body', async () => {
    await withRawServer(
      () => 'HTTP/1.1 204 No Content\r\n\r\n',
      async (base) => {
        const result = await safeFetch(request(`${base}/`), PRIVATE);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe(204);
          expect(result.value.body).toBe('');
        }
      },
    );
  });
});

describe('request encoding', () => {
  test('always sets Host and Connection: close and never leaks framing overrides', async () => {
    await withRawServer(
      (received) => `HTTP/1.1 200 OK\r\nContent-Length: ${received.length}\r\n\r\n${received}`,
      async (base, port) => {
        const result = await safeFetch(
          request(`${base}/hook`, {
            method: 'POST',
            headers: {
              'X-Ok': 'keep',
              Host: 'evil.test',
              'Content-Length': '999',
              'Transfer-Encoding': 'chunked',
              'X-Inject': 'a\r\nX-Evil: 1',
              'bad name': 'x',
            },
            body: 'hello',
          }),
          PRIVATE,
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const sent = result.value.body;
        expect(sent.startsWith('POST /hook HTTP/1.1\r\n')).toBe(true);
        expect(sent).toContain(`Host: 127.0.0.1:${port}\r\n`);
        expect(sent).toContain('Connection: close\r\n');
        expect(sent).toContain('X-Ok: keep\r\n');
        expect(sent).toContain('Content-Length: 5\r\n');
        expect(sent).not.toContain('evil.test');
        expect(sent).not.toContain('X-Evil');
        expect(sent).not.toContain('999');
        expect(sent).not.toContain('bad name');
        expect(sent.endsWith('\r\n\r\nhello')).toBe(true);
      },
    );
  });
});
