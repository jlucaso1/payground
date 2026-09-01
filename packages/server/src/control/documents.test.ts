import { afterEach, describe, expect, test } from 'bun:test';
import { type TestServer, startTestServer } from '../testing.ts';

let app: TestServer | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

const preference = {
  items: [{ id: 'sku', title: 'A thing', quantity: 1, unit_price: 10, currency_id: 'BRL' }],
  external_reference: 'ORDER-DOC-1',
  payer: { email: 'buyer@example.com' },
};

async function seeded(): Promise<TestServer> {
  const server = startTestServer();
  app = server;
  await server.api('POST', '/checkout/preferences', { body: preference });
  await server.api('POST', '/checkout/preferences', {
    body: { ...preference, external_reference: 'ORDER-DOC-2' },
  });
  return server;
}

describe('document kinds', () => {
  test('lists every kind the emulator supports, with counts', async () => {
    const server = await seeded();
    const { status, body } = await server.control('GET', `/_payground/sandboxes/${server.sandboxId}/documents/kinds`);

    expect(status).toBe(200);
    expect(body.length).toBe(26);
    expect(body.find((entry: { kind: string }) => entry.kind === 'preference')).toEqual({
      kind: 'preference',
      count: 2,
    });
    expect(body.find((entry: { kind: string }) => entry.kind === 'claim')).toEqual({ kind: 'claim', count: 0 });
  });

  test('needs the admin token and a known sandbox', async () => {
    const server = await seeded();
    expect(
      (await server.control('GET', `/_payground/sandboxes/${server.sandboxId}/documents/kinds`, undefined, null))
        .status,
    ).toBe(401);
    expect((await server.control('GET', '/_payground/sandboxes/ghost/documents/kinds')).status).toBe(404);
  });
});

describe('document listing', () => {
  const path = (server: TestServer, query: string) =>
    `/_payground/sandboxes/${server.sandboxId}/documents?${query}`;

  test('pages a kind and reports the total', async () => {
    const server = await seeded();
    const { status, body } = await server.control('GET', path(server, 'kind=preference'));

    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({ kind: 'preference' });
    expect(body.results[0].doc).toBeObject();
  });

  test('filters by external reference and free text', async () => {
    const server = await seeded();
    expect((await server.control('GET', path(server, 'kind=preference&external_reference=ORDER-DOC-2'))).body.total).toBe(1);
    expect((await server.control('GET', path(server, 'kind=preference&q=ORDER-DOC-1'))).body.total).toBe(1);
    expect((await server.control('GET', path(server, 'kind=preference&q=A thing'))).body.total).toBe(2);
    expect((await server.control('GET', path(server, 'kind=preference&q=nothing-matches'))).body.total).toBe(0);
  });

  test('a wildcard in the search text is data, not a pattern', async () => {
    const server = await seeded();
    // No preference contains a percent sign; every one contains an underscore (init_point).
    expect((await server.control('GET', path(server, `kind=preference&q=${encodeURIComponent('%')}`))).body.total).toBe(0);
    expect((await server.control('GET', path(server, `kind=preference&q=${encodeURIComponent('_')}`))).body.total).toBe(2);
    expect((await server.control('GET', path(server, `kind=preference&q=${encodeURIComponent('init_point')}`))).body.total).toBe(2);
  });

  test('honours limit and offset and clamps hostile values', async () => {
    const server = await seeded();
    expect((await server.control('GET', path(server, 'kind=preference&limit=1'))).body.results).toHaveLength(1);
    expect((await server.control('GET', path(server, 'kind=preference&limit=1&offset=1'))).body.results).toHaveLength(1);
    expect((await server.control('GET', path(server, 'kind=preference&limit=1e30'))).body.limit).toBeLessThanOrEqual(1000);
    expect((await server.control('GET', path(server, 'kind=preference&offset=-5'))).body.offset).toBe(0);
  });

  test('an unknown kind is a 400, not an empty page', async () => {
    const server = await seeded();
    expect((await server.control('GET', path(server, 'kind=not_a_kind'))).status).toBe(400);
    expect((await server.control('GET', path(server, ''))).status).toBe(400);
  });
});

describe('single document', () => {
  test('reads one back by kind and id', async () => {
    const server = await seeded();
    const listed = await server.control('GET', `/_payground/sandboxes/${server.sandboxId}/documents?kind=preference`);
    const first = listed.body.results[0];

    const { status, body } = await server.control(
      'GET',
      `/_payground/sandboxes/${server.sandboxId}/documents/preference/${encodeURIComponent(first.id)}`,
    );
    expect(status).toBe(200);
    expect(body).toEqual(first);
  });

  test('a missing document or kind is a 404 that names the document, not the sandbox', async () => {
    const server = await seeded();
    const missing = await server.control(
      'GET',
      `/_payground/sandboxes/${server.sandboxId}/documents/preference/nope`,
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error).toContain('document');

    const badKind = await server.control('GET', `/_payground/sandboxes/${server.sandboxId}/documents/nope/nope`);
    expect(badKind.status).toBe(404);
  });

  test('one sandbox cannot read another sandbox documents', async () => {
    const server = await seeded();
    const other = await server.control('POST', '/_payground/sandboxes', { name: 'other' });
    const page = await server.control('GET', `/_payground/sandboxes/${other.body.id}/documents?kind=preference`);
    expect(page.body.total).toBe(0);
  });
});
