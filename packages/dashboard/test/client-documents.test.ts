import { describe, expect, test } from 'bun:test';
import type { FetchLike } from '../src/api/client.ts';
import {
  buildDocumentQuery,
  createDocumentsClient,
  isUnavailable,
  type StoredDocument,
} from '../src/api/client-documents.ts';

interface Call {
  url: string;
  headers: Record<string, string>;
}

function recorder(handler: () => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: (init?.headers as Record<string, string> | undefined) ?? {} });
    return await Promise.resolve(handler());
  };
  return { fetch: fetchImpl, calls };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

const DOC: StoredDocument = {
  kind: 'preference',
  id: 'pref_1',
  sequence: 1,
  status: 'active',
  externalReference: 'order-1',
  lookup: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  expiresAt: null,
  doc: { id: 'pref_1' },
};

describe('buildDocumentQuery', () => {
  test('is empty with no filters', () => {
    expect(buildDocumentQuery({})).toBe('');
  });

  test('drops empty strings', () => {
    expect(buildDocumentQuery({ kind: '', status: '', external_reference: '', q: '' })).toBe('');
  });

  test('serialises every filter and encodes them', () => {
    expect(
      buildDocumentQuery({
        kind: 'preapproval_plan',
        status: 'active',
        external_reference: 'order 1',
        q: 'a&b',
        limit: 25,
        offset: 50,
      }),
    ).toBe('?kind=preapproval_plan&status=active&external_reference=order+1&q=a%26b&limit=25&offset=50');
  });

  test('keeps offset zero', () => {
    expect(buildDocumentQuery({ limit: 10, offset: 0 })).toBe('?limit=10&offset=0');
  });
});

describe('documents client', () => {
  test('listKinds hits the kinds endpoint', async () => {
    const { fetch, calls } = recorder(() => json([{ kind: 'preference', count: 2 }]));
    const result = await createDocumentsClient({ fetch }).listKinds('sbx_1');
    expect(result).toEqual({ ok: true, value: [{ kind: 'preference', count: 2 }] });
    expect(calls[0]?.url).toBe('/_payground/sandboxes/sbx_1/documents/kinds');
  });

  test('listDocuments appends the query string', async () => {
    const { fetch, calls } = recorder(() => json({ total: 1, limit: 25, offset: 0, results: [DOC] }));
    const result = await createDocumentsClient({ fetch }).listDocuments('sbx_1', {
      kind: 'preference',
      limit: 25,
      offset: 0,
    });
    expect(result.ok && result.value.results[0]?.id).toBe('pref_1');
    expect(calls[0]?.url).toBe(
      '/_payground/sandboxes/sbx_1/documents?kind=preference&limit=25&offset=0',
    );
  });

  test('getDocument percent-encodes the kind and id', async () => {
    const { fetch, calls } = recorder(() => json(DOC));
    await createDocumentsClient({ fetch }).getDocument('a/b', 'pre ference', 'id/1');
    expect(calls[0]?.url).toBe('/_payground/sandboxes/a%2Fb/documents/pre%20ference/id%2F1');
  });

  test('honours the base url and the admin token', async () => {
    const { fetch, calls } = recorder(() => json([]));
    await createDocumentsClient({
      fetch,
      baseUrl: 'http://localhost:3000/',
      token: () => 'secret',
    }).listKinds('sbx_1');
    expect(calls[0]?.url).toBe('http://localhost:3000/_payground/sandboxes/sbx_1/documents/kinds');
    expect(calls[0]?.headers['authorization']).toBe('Bearer secret');
  });

  test('omits the token header when there is none', async () => {
    const { fetch, calls } = recorder(() => json([]));
    await createDocumentsClient({ fetch, token: () => '' }).listKinds('sbx_1');
    expect(calls[0]?.headers['authorization']).toBeUndefined();
  });

  test('reads the token on every call', async () => {
    const { fetch, calls } = recorder(() => json([]));
    let current: string | null = null;
    const client = createDocumentsClient({ fetch, token: () => current });
    await client.listKinds('sbx_1');
    current = 'later';
    await client.listKinds('sbx_1');
    expect(calls[0]?.headers['authorization']).toBeUndefined();
    expect(calls[1]?.headers['authorization']).toBe('Bearer later');
  });

  test('never throws', async () => {
    const { fetch } = recorder(() => new Response('nope', { status: 503 }));
    const client = createDocumentsClient({ fetch });
    const results = await Promise.all([
      client.listKinds('s'),
      client.listDocuments('s'),
      client.getDocument('s', 'preference', 'p'),
    ]);
    expect(results.every((result) => !result.ok)).toBe(true);
  });

  test('a network failure is reported, not thrown', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'));
    const result = await createDocumentsClient({ fetch: fetchImpl }).listKinds('s');
    expect(result).toEqual({
      ok: false,
      error: { kind: 'network', message: 'Failed to fetch', status: null },
    });
  });

  test('a 401 is reported as unauthorized', async () => {
    const { fetch } = recorder(() => new Response('{}', { status: 401 }));
    const result = await createDocumentsClient({ fetch }).listKinds('s');
    expect(result.ok ? null : result.error.kind).toBe('unauthorized');
  });

  test('invalid JSON becomes a parse error', async () => {
    const { fetch } = recorder(() => new Response('<html>', { status: 200 }));
    const result = await createDocumentsClient({ fetch }).listKinds('s');
    expect(result.ok ? null : result.error.kind).toBe('parse');
  });
});

describe('isUnavailable', () => {
  test('a 404 means the endpoint is not deployed', () => {
    expect(isUnavailable({ kind: 'http', message: 'not found', status: 404 })).toBe(true);
  });

  test('a non-JSON body means the request fell through to the SPA', () => {
    expect(isUnavailable({ kind: 'parse', message: 'bad json', status: 200 })).toBe(true);
  });

  test('a missing sandbox stays a real error', () => {
    expect(
      isUnavailable({ kind: 'http', message: '{"error":"sandbox not found"}', status: 404 }),
    ).toBe(false);
  });

  test('other failures are real errors', () => {
    expect(isUnavailable({ kind: 'http', message: 'boom', status: 500 })).toBe(false);
    expect(isUnavailable({ kind: 'unauthorized', message: 'no', status: 401 })).toBe(false);
    expect(isUnavailable({ kind: 'network', message: 'offline', status: null })).toBe(false);
  });
});
