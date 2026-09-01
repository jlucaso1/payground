import { describe, expect, test } from 'bun:test';
import type { FetchLike } from '../src/api/client.ts';
import {
  buildAuditQuery,
  buildRequestQuery,
  createObservabilityClient,
  isUnavailable,
} from '../src/api/client-observability.ts';
import type { ApiRequestEntry, MetricsView } from '../src/api/types.ts';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function recorder(handler: (call: Call) => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string> | undefined) ?? {},
    };
    calls.push(call);
    return await Promise.resolve(handler(call));
  };
  return { fetch: fetchImpl, calls };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

const METRICS: MetricsView = {
  totals: { requests: 3, errors: 1 },
  routes: [{ route: '/v1/payments', method: 'POST', count: 3, errors: 1, p50: 4, p95: 9, p99: 12 }],
};

const ENTRY: ApiRequestEntry = {
  id: 'req_1',
  at: 1_700_000_000_000,
  sandbox: 'sbx_1',
  method: 'POST',
  route: '/v1/payments',
  path: '/v1/payments',
  status: 201,
  durationMs: 7,
  requestBody: '{"a":1}',
  responseBody: '{"id":1}',
  idempotencyKey: null,
  userAgent: 'bun',
};

describe('buildRequestQuery', () => {
  test('is empty when nothing is filtered', () => {
    expect(buildRequestQuery({})).toBe('');
  });

  test('serialises every supported filter', () => {
    expect(
      buildRequestQuery({
        sandbox: 'sbx_1',
        route: '/v1/payments',
        method: 'POST',
        status: 201,
        min_status: 400,
        from: 10,
        to: 20,
        limit: 25,
        offset: 50,
      }),
    ).toBe(
      '?sandbox=sbx_1&route=%2Fv1%2Fpayments&method=POST&status=201&min_status=400&from=10&to=20&limit=25&offset=50',
    );
  });

  test('drops empty strings but keeps zeroes', () => {
    expect(buildRequestQuery({ route: '', offset: 0, from: 0 })).toBe('?from=0&offset=0');
  });
});

describe('buildAuditQuery', () => {
  test('serialises every supported filter', () => {
    expect(
      buildAuditQuery({ sandbox: 'sbx_1', action: 'sandbox.create', from: 1, to: 2, limit: 5, offset: 0 }),
    ).toBe('?sandbox=sbx_1&action=sandbox.create&from=1&to=2&limit=5&offset=0');
  });
});

describe('observability client', () => {
  test('reads global metrics as json', async () => {
    const { fetch, calls } = recorder(() => json(METRICS));
    const result = await createObservabilityClient({ fetch }).getMetrics(null);
    expect(result).toEqual({ ok: true, value: METRICS });
    expect(calls[0]?.url).toBe('/_payground/metrics?format=json');
  });

  test('scopes metrics to a sandbox and escapes the id', async () => {
    const { fetch, calls } = recorder(() => json(METRICS));
    await createObservabilityClient({ fetch }).getMetrics('sbx/1');
    expect(calls[0]?.url).toBe('/_payground/sandboxes/sbx%2F1/metrics?format=json');
  });

  test('sends the admin token', async () => {
    const { fetch, calls } = recorder(() => json(METRICS));
    await createObservabilityClient({ fetch, token: () => 'secret' }).getMetrics(null);
    expect(calls[0]?.headers['authorization']).toBe('Bearer secret');
  });

  test('lists requests with filters', async () => {
    const { fetch, calls } = recorder(() => json({ total: 1, limit: 25, offset: 0, results: [ENTRY] }));
    const result = await createObservabilityClient({ fetch }).listRequests({
      sandbox: 'sbx_1',
      min_status: 400,
      limit: 25,
      offset: 0,
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('/_payground/requests?sandbox=sbx_1&min_status=400&limit=25&offset=0');
  });

  test('fetches one request by id', async () => {
    const { fetch, calls } = recorder(() => json(ENTRY));
    const result = await createObservabilityClient({ fetch }).getRequest('req 1');
    expect(result).toEqual({ ok: true, value: ENTRY });
    expect(calls[0]?.url).toBe('/_payground/requests/req%201');
  });

  test('lists audit entries', async () => {
    const { fetch, calls } = recorder(() => json({ total: 0, limit: 25, offset: 0, results: [] }));
    await createObservabilityClient({ fetch }).listAudit({ action: 'sandbox.delete' });
    expect(calls[0]?.url).toBe('/_payground/audit?action=sandbox.delete');
  });

  test('honours the base url', async () => {
    const { fetch, calls } = recorder(() => json(METRICS));
    await createObservabilityClient({ fetch, baseUrl: 'http://host:1/' }).getMetrics(null);
    expect(calls[0]?.url).toBe('http://host:1/_payground/metrics?format=json');
  });
});

describe('failure paths', () => {
  test('a missing endpoint reads as unavailable', async () => {
    const { fetch } = recorder(() => new Response('', { status: 404 }));
    const result = await createObservabilityClient({ fetch }).getMetrics(null);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toEqual({ kind: 'http', message: 'HTTP 404', status: 404 });
    expect(isUnavailable(result.error)).toBe(true);
  });

  test('401 is reported as unauthorized, not unavailable', async () => {
    const { fetch } = recorder(() => new Response('nope', { status: 401 }));
    const result = await createObservabilityClient({ fetch }).listRequests({});
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('unauthorized');
    expect(isUnavailable(result.error)).toBe(false);
  });

  test('a network failure is reported without a status', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error('offline'));
    const result = await createObservabilityClient({ fetch: fetchImpl }).listAudit({});
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toEqual({ kind: 'network', message: 'offline', status: null });
  });

  test('malformed json is a parse error', async () => {
    const { fetch } = recorder(() => new Response('{', { status: 200 }));
    const result = await createObservabilityClient({ fetch }).getRequest('req_1');
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('parse');
  });
});
