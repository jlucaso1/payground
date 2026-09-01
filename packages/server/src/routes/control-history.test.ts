import { afterEach, describe, expect, test } from 'bun:test';
import type { ApiRequestEntry, AuditEntry, SandboxId } from '@payground/core';
import { TEST_NOW, startTestServer } from '../testing.ts';

let app: ReturnType<typeof startTestServer> | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

const start = () => {
  app = startTestServer();
  return app;
};

const pix = { transaction_amount: 100, payment_method_id: 'pix', payer: { email: 'a@b.c' } };

const entry = (over: Partial<ApiRequestEntry> = {}): ApiRequestEntry => ({
  id: 'req-1',
  at: TEST_NOW,
  sandbox: null,
  method: 'POST',
  route: '/v1/card_tokens',
  path: '/v1/card_tokens',
  status: 201,
  durationMs: 3,
  requestBody: null,
  responseBody: null,
  idempotencyKey: null,
  userAgent: null,
  ...over,
});

const audit = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 'aud-1',
  at: TEST_NOW,
  actor: { kind: 'admin' },
  action: 'sandbox.created',
  target: 'sbx',
  sandbox: null,
  detail: {},
  ...over,
});

describe('GET /_payground/requests', () => {
  test('lists the calls the emulator answered, newest first', async () => {
    const server = start();
    await server.api('POST', '/v1/payments', { body: pix });
    await server.api('GET', '/v1/payments/999999');

    const { status, body } = await server.control('GET', '/_payground/requests?limit=10');
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.results[0]).toMatchObject({ method: 'GET', route: '/v1/payments/:id', status: 404 });
    expect(body.results[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(body.results[1]).toMatchObject({ method: 'POST', route: '/v1/payments', status: 201 });
    expect(body.results[0].responseBody).toBeUndefined();
  });

  test('filters by method, status, min_status and route', async () => {
    const server = start();
    await server.api('POST', '/v1/payments', { body: pix });
    await server.api('GET', '/v1/payments/999999');

    expect((await server.control('GET', '/_payground/requests?method=get')).body.total).toBe(1);
    expect((await server.control('GET', '/_payground/requests?status=201')).body.total).toBe(1);
    expect((await server.control('GET', '/_payground/requests?min_status=400')).body.total).toBe(1);
    expect((await server.control('GET', '/_payground/requests?route=/v1/payments')).body.total).toBe(1);
    expect((await server.control('GET', '/_payground/requests?route=/nope')).body.total).toBe(0);
  });

  test('an empty or malformed filter is ignored rather than matching nothing', async () => {
    const server = start();
    await server.api('POST', '/v1/payments', { body: pix });

    for (const query of ['route=', 'sandbox=', 'method=', 'status=', 'limit=1.7', 'offset=1e30', 'from=x']) {
      const { status, body } = await server.control('GET', `/_payground/requests?${query}`);
      expect({ query, status, total: body.total }).toEqual({ query, status: 200, total: 1 });
    }
  });

  test('filters by sandbox and by time window, and pages', async () => {
    const server = start();
    await server.api('POST', '/v1/payments', { body: pix });
    await server.api('POST', '/v1/payments', { body: pix });

    const scoped = await server.control('GET', `/_payground/requests?sandbox=${server.sandboxId}`);
    expect(scoped.body.total).toBe(2);
    expect((await server.control('GET', '/_payground/requests?sandbox=missing')).body.total).toBe(0);

    expect((await server.control('GET', `/_payground/requests?from=${TEST_NOW + 1}`)).body.total).toBe(0);
    expect((await server.control('GET', `/_payground/requests?to=${TEST_NOW - 1}`)).body.total).toBe(0);

    const paged = await server.control('GET', '/_payground/requests?limit=1&offset=1');
    expect(paged.body).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(paged.body.results).toHaveLength(1);
  });

  test('the sandbox-scoped list only shows that sandbox', async () => {
    const server = start();
    await server.api('POST', '/v1/payments', { body: pix });
    await server.api('GET', '/v1/payments/search', { token: null });

    expect((await server.control('GET', '/_payground/requests')).body.total).toBe(2);
    const scoped = await server.control('GET', `/_payground/sandboxes/${server.sandboxId}/requests`);
    expect(scoped.body.total).toBe(1);
    expect(scoped.body.results[0].sandbox).toBe(server.sandboxId);
  });

  test('needs the admin token', async () => {
    const server = start();
    expect((await server.control('GET', '/_payground/requests', undefined, null)).status).toBe(401);
    expect((await server.control('GET', '/_payground/audit', undefined, 'wrong')).status).toBe(401);
  });
});

describe('GET /_payground/requests/:id', () => {
  test('returns the bodies with card data and secrets redacted', async () => {
    const server = start();
    server.storage.requests.record(
      entry({
        requestBody: JSON.stringify({ card_number: '4509953566233704', security_code: '123', cardholder: 'A' }),
        responseBody: JSON.stringify({
          id: 'tok',
          client_secret: 'sh-abcdef',
          first_six_digits: '450995',
          nested: [{ pan: '4509953566233704' }],
        }),
      }),
    );

    const { status, body } = await server.control('GET', '/_payground/requests/req-1');
    expect(status).toBe(200);
    expect(body.requestBody).not.toContain('4509953566233704');
    expect(body.requestBody).not.toContain('123');
    expect(JSON.parse(body.requestBody).cardholder).toBe('A');
    expect(body.responseBody).not.toContain('4509953566233704');
    expect(body.responseBody).not.toContain('sh-abcdef');
    expect(JSON.parse(body.responseBody).first_six_digits).toBe('450995');
  });

  test('a body that is not Json is still scrubbed', async () => {
    const server = start();
    server.storage.requests.record(entry({ responseBody: 'card=4509953566233704 end' }));
    const { body } = await server.control('GET', '/_payground/requests/req-1');
    expect(body.responseBody).toBe('card=[redacted] end');
  });

  test('a grouped or trailed card number is caught, a barcode is left readable', async () => {
    const server = start();
    server.storage.requests.record(
      entry({
        responseBody: JSON.stringify({
          grouped: '4509 9535 6623 3704',
          trailed: 'paid 4509953566233704 12/26',
          dashed: '4509-9535-6623-3704',
          barcode: '34191790010104351004791020150008291070026000',
          at: 1_700_000_000_000,
        }),
      }),
    );

    const parsed = JSON.parse((await server.control('GET', '/_payground/requests/req-1')).body.responseBody);
    expect(parsed.grouped).toBe('[redacted]');
    expect(parsed.dashed).toBe('[redacted]');
    expect(parsed.trailed).toBe('paid [redacted]/26');
    expect(parsed.barcode).toBe('34191790010104351004791020150008291070026000');
    expect(parsed.at).toBe(1_700_000_000_000);
  });

  test('an unknown id is a 404', async () => {
    const server = start();
    expect((await server.control('GET', '/_payground/requests/nope')).status).toBe(404);
  });
});

describe('audit trail', () => {
  test('lists entries and filters by action and sandbox', async () => {
    const server = start();
    const sandbox = server.sandboxId as SandboxId;
    server.storage.audit.record(audit({ id: 'a', sandbox, detail: { name: 'x' } }));
    server.storage.audit.record(audit({ id: 'b', at: TEST_NOW + 1, action: 'faults.updated', sandbox }));
    server.storage.audit.record(audit({ id: 'c', at: TEST_NOW + 2, action: 'sandbox.deleted' }));

    const all = await server.control('GET', '/_payground/audit');
    expect(all.body.total).toBe(3);
    expect(all.body.results[0]).toMatchObject({ id: 'c', actor: { kind: 'admin' } });

    expect((await server.control('GET', '/_payground/audit?action=faults.updated')).body.total).toBe(1);
    expect((await server.control('GET', `/_payground/audit?sandbox=${sandbox}`)).body.total).toBe(2);
    expect((await server.control('GET', `/_payground/audit?from=${TEST_NOW + 2}`)).body.total).toBe(1);
    expect((await server.control('GET', `/_payground/audit?to=${TEST_NOW}`)).body.total).toBe(1);

    const scoped = await server.control('GET', `/_payground/sandboxes/${sandbox}/audit`);
    expect(scoped.body.total).toBe(2);
    expect(scoped.body.results.map((e: AuditEntry) => e.id)).toEqual(['b', 'a']);
  });
});

describe('retention', () => {
  test('purges history and audit entries older than the cutoff', async () => {
    const server = start();
    server.storage.requests.record(entry({ id: 'old', at: TEST_NOW - 10 }));
    server.storage.requests.record(entry({ id: 'new' }));
    server.storage.audit.record(audit({ id: 'old', at: TEST_NOW - 10 }));
    server.storage.audit.record(audit({ id: 'new' }));

    expect((await server.control('DELETE', `/_payground/requests?before=${TEST_NOW}`)).body).toEqual({ deleted: 1 });
    expect((await server.control('GET', '/_payground/requests')).body.results[0].id).toBe('new');

    // The requests purge is itself audited, so the audit purge sees three entries.
    expect((await server.control('DELETE', `/_payground/audit?before=${TEST_NOW}`)).body).toEqual({ deleted: 1 });
    const remaining = (await server.control('GET', '/_payground/audit')).body.results as AuditEntry[];
    expect(remaining.map((e) => e.action).sort()).toEqual(['audit.purged', 'requests.purged', 'sandbox.created']);
    const purged = remaining.find((e) => e.action === 'audit.purged');
    expect(purged?.detail).toEqual({ before: TEST_NOW, deleted: 1 });
  });

  test('a purge without a cutoff is refused', async () => {
    const server = start();
    const { status, body } = await server.control('DELETE', '/_payground/requests');
    expect(status).toBe(400);
    expect(body.error).toBe('before is required');
    expect((await server.control('DELETE', '/_payground/audit?before=abc')).status).toBe(400);
  });
});
