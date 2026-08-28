import { describe, expect, test } from 'bun:test';
import { buildQuery, createApiClient, type FetchLike } from '../src/api/client.ts';
import type { FaultProfile, PaymentPage, Sandbox } from '../src/api/types.ts';

interface Call {
  url: string;
  method: string;
  body: string | null;
  headers: Record<string, string>;
}

function recorder(handler: (call: Call) => Response | Promise<Response>): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
      headers: (init?.headers as Record<string, string> | undefined) ?? {},
    };
    calls.push(call);
    return await handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SANDBOX: Sandbox = {
  id: 'sbx_1',
  name: 'demo',
  accessToken: 'TEST-token',
  publicKey: 'TEST-key',
  webhookSecret: 'whsec',
  liveMode: false,
  createdAt: 1_700_000_000_000,
};

describe('buildQuery', () => {
  test('is empty when no filters are set', () => {
    expect(buildQuery({})).toBe('');
  });

  test('omits empty strings and undefined values', () => {
    expect(buildQuery({ method: '', external_reference: '' })).toBe('');
  });

  test('serialises every supported filter', () => {
    expect(
      buildQuery({
        state: 'succeeded',
        method: 'pix',
        external_reference: 'order 1',
        limit: 25,
        offset: 50,
      }),
    ).toBe('?state=succeeded&method=pix&external_reference=order+1&limit=25&offset=50');
  });

  test('keeps offset zero', () => {
    expect(buildQuery({ limit: 10, offset: 0 })).toBe('?limit=10&offset=0');
  });
});

describe('success paths', () => {
  test('listSandboxes hits the control prefix', async () => {
    const { fetch, calls } = recorder(() => json([SANDBOX]));
    const result = await createApiClient({ fetch }).listSandboxes();
    expect(result).toEqual({ ok: true, value: [SANDBOX] });
    expect(calls[0]?.url).toBe('/_payground/sandboxes');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.body).toBe(null);
  });

  test('honours a base url and strips its trailing slash', async () => {
    const { fetch, calls } = recorder(() => json({ status: 'ok', version: '1', uptime_ms: 5 }));
    await createApiClient({ fetch, baseUrl: 'http://localhost:3000/' }).getHealth();
    expect(calls[0]?.url).toBe('http://localhost:3000/_payground/health');
  });

  test('createSandbox posts a JSON body', async () => {
    const { fetch, calls } = recorder(() => json(SANDBOX));
    const result = await createApiClient({ fetch }).createSandbox('demo');
    expect(result.ok).toBe(true);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toBe('{"name":"demo"}');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
  });

  test('percent-encodes path parameters', async () => {
    const { fetch, calls } = recorder(() => json({ ok: true }));
    await createApiClient({ fetch }).replayWebhook('a/b', 'w 1');
    expect(calls[0]?.url).toBe('/_payground/sandboxes/a%2Fb/webhooks/w%201/replay');
  });

  test('applyAction forwards the discriminated action', async () => {
    const { fetch, calls } = recorder(() => json({ payment: { id: 'pay_1' } }));
    await createApiClient({ fetch }).applyAction('sbx_1', 'pay_1', { type: 'refund', amount: 500 });
    expect(calls[0]?.url).toBe('/_payground/sandboxes/sbx_1/payments/pay_1/actions');
    expect(calls[0]?.body).toBe('{"type":"refund","amount":500}');
  });

  test('setFaults uses PUT', async () => {
    const profile: FaultProfile = {
      latencyMs: 120,
      errorRate: 0.1,
      unavailable: false,
      duplicateWebhooks: true,
      webhookFailureRate: 0,
    };
    const { fetch, calls } = recorder(() => json(profile));
    const result = await createApiClient({ fetch }).setFaults('sbx_1', profile);
    expect(result).toEqual({ ok: true, value: profile });
    expect(calls[0]?.method).toBe('PUT');
  });

  test('deleteSandbox uses DELETE', async () => {
    const { fetch, calls } = recorder(() => json({ ok: true }));
    await createApiClient({ fetch }).deleteSandbox('sbx_1');
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe('/_payground/sandboxes/sbx_1');
  });
});

describe('paging', () => {
  const page = (offset: number): PaymentPage => ({
    total: 57,
    limit: 25,
    offset,
    results: [],
  });

  test('passes limit and offset through and returns the envelope', async () => {
    const { fetch, calls } = recorder((call) =>
      json(page(call.url.includes('offset=25') ? 25 : 0)),
    );
    const client = createApiClient({ fetch });

    const first = await client.listPayments('sbx_1', { limit: 25, offset: 0 });
    const second = await client.listPayments('sbx_1', { limit: 25, offset: 25 });

    expect(calls[0]?.url).toBe('/_payground/sandboxes/sbx_1/payments?limit=25&offset=0');
    expect(calls[1]?.url).toBe('/_payground/sandboxes/sbx_1/payments?limit=25&offset=25');
    expect(first.ok && first.value.offset).toBe(0);
    expect(second.ok && second.value.offset).toBe(25);
    expect(second.ok && second.value.total).toBe(57);
  });

  test('omits the query string when no options are given', async () => {
    const { fetch, calls } = recorder(() => json(page(0)));
    await createApiClient({ fetch }).listPayments('sbx_1');
    expect(calls[0]?.url).toBe('/_payground/sandboxes/sbx_1/payments');
  });
});

describe('failure paths', () => {
  test('HTTP error carries the status and body', async () => {
    const { fetch } = recorder(() => new Response('sandbox not found', { status: 404 }));
    const result = await createApiClient({ fetch }).listSandboxes();
    expect(result).toEqual({
      ok: false,
      error: { kind: 'http', message: 'sandbox not found', status: 404 },
    });
  });

  test('HTTP error with an empty body falls back to the status line', async () => {
    const { fetch } = recorder(() => new Response('', { status: 500 }));
    const result = await createApiClient({ fetch }).listSandboxes();
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.message).toBe('HTTP 500');
  });

  test('network failure is reported instead of thrown', async () => {
    const { fetch } = recorder(() => {
      throw new TypeError('Failed to fetch');
    });
    const result = await createApiClient({ fetch }).getHealth();
    expect(result).toEqual({
      ok: false,
      error: { kind: 'network', message: 'Failed to fetch', status: null },
    });
  });

  test('non-Error rejections are stringified', async () => {
    const fetchImpl: FetchLike = () => Promise.reject('boom');
    const result = await createApiClient({ fetch: fetchImpl }).getHealth();
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.kind).toBe('network');
    expect(result.ok ? null : result.error.message).toBe('boom');
  });

  test('invalid JSON on a 200 becomes a parse error', async () => {
    const { fetch } = recorder(() => new Response('<html>', { status: 200 }));
    const result = await createApiClient({ fetch }).listSandboxes();
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.kind).toBe('parse');
    expect(result.ok ? null : result.error.status).toBe(200);
  });

  test('never throws for any endpoint', async () => {
    const { fetch } = recorder(() => new Response('nope', { status: 503 }));
    const client = createApiClient({ fetch });
    const results = await Promise.all([
      client.getHealth(),
      client.listSandboxes(),
      client.createSandbox('x'),
      client.resetSandbox('s'),
      client.deleteSandbox('s'),
      client.listPayments('s'),
      client.getPayment('s', 'p'),
      client.applyAction('s', 'p', { type: 'settle' }),
      client.listWebhooks('s'),
      client.replayWebhook('s', 'w'),
      client.getFaults('s'),
      client.setFaults('s', {
        latencyMs: 0,
        errorRate: 0,
        unavailable: false,
        duplicateWebhooks: false,
        webhookFailureRate: 0,
      }),
    ]);
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(results.length).toBe(12);
  });
});
