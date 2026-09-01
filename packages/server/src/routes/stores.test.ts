import { afterEach, describe, expect, test } from 'bun:test';
import { type TestServer, startTestServer } from '../testing.ts';

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

/** The collector is derived from the sandbox; a payment is the cheapest way to read it. */
async function start(): Promise<{ api: TestServer; collector: number }> {
  const api = startTestServer();
  server = api;
  const payment = await api.api('POST', '/v1/payments', {
    body: {
      transaction_amount: 10,
      payment_method_id: 'pix',
      payer: { email: 'payer@example.com' },
    },
  });
  return { api, collector: payment.body.collector_id as number };
}

const store = (overrides: Record<string, unknown> = {}) => ({ name: 'Loja 1', ...overrides });

describe('stores', () => {
  test('creates, reads, updates and searches a store', async () => {
    const { api, collector } = await start();

    const created = await api.api('POST', `/users/${collector}/stores`, {
      body: store({
        external_id: 'L1',
        location: { street_name: 'Av. Paulista', street_number: '1000', city_name: 'Sao Paulo' },
        business_hours: { monday: [{ open: '09:00', close: '18:00' }] },
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('Loja 1');
    expect(created.body.external_id).toBe('L1');
    expect(created.body.user_id).toBe(collector);
    expect(created.body.location.city_name).toBe('Sao Paulo');
    expect(typeof created.body.id).toBe('string');
    expect(created.body.date_created).toBe(created.body.date_last_updated);

    const read = await api.api('GET', `/stores/${created.body.id}`);
    expect(read.status).toBe(200);
    expect(read.body.id).toBe(created.body.id);

    api.clock.advance(1000);
    const updated = await api.api('PUT', `/users/${collector}/stores/${created.body.id}`, {
      body: store({ name: 'Loja 1 renomeada', external_id: 'L1' }),
    });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('Loja 1 renomeada');
    expect(updated.body.date_last_updated).not.toBe(updated.body.date_created);

    await api.api('POST', `/users/${collector}/stores`, { body: store({ name: 'Loja 2', external_id: 'L2' }) });

    const all = await api.api('GET', `/users/${collector}/stores/search`);
    expect(all.body.paging).toEqual({ total: 2, limit: 30, offset: 0 });
    expect(all.body.results).toHaveLength(2);

    const filtered = await api.api('GET', `/users/${collector}/stores/search?external_id=L2`);
    expect(filtered.body.paging.total).toBe(1);
    expect(filtered.body.results[0].name).toBe('Loja 2');

    const paged = await api.api('GET', `/users/${collector}/stores/search?limit=1&offset=1`);
    expect(paged.body.paging).toEqual({ total: 2, limit: 1, offset: 1 });
    expect(paged.body.results).toHaveLength(1);
  });

  test('rejects an invalid body and a duplicate external_id', async () => {
    const { api, collector } = await start();

    const missing = await api.api('POST', `/users/${collector}/stores`, { body: {} });
    expect(missing.status).toBe(400);
    expect(missing.body.cause[0].description).toContain('name');

    const blank = await api.api('POST', `/users/${collector}/stores`, { body: store({ name: '  ' }) });
    expect(blank.status).toBe(400);

    const first = await api.api('POST', `/users/${collector}/stores`, { body: store({ external_id: 'L1' }) });
    expect(first.status).toBe(201);

    const again = await api.api('POST', `/users/${collector}/stores`, { body: store({ external_id: 'L1' }) });
    expect(again.status).toBe(400);
    expect(again.body.cause[0].code).toBe('store_exists');

    const stolen = await api.api('POST', `/users/${collector}/stores`, { body: store({ external_id: 'L2' }) });
    const collide = await api.api('PUT', `/users/${collector}/stores/${stolen.body.id}`, {
      body: store({ external_id: 'L1' }),
    });
    expect(collide.status).toBe(400);
  });

  test('another collector sees nothing', async () => {
    const { api, collector } = await start();
    const other = collector + 1;

    const created = await api.api('POST', `/users/${collector}/stores`, { body: store({ external_id: 'L1' }) });

    for (const call of [
      api.api('POST', `/users/${other}/stores`, { body: store() }),
      api.api('GET', `/users/${other}/stores/search`),
      api.api('PUT', `/users/${other}/stores/${created.body.id}`, { body: store() }),
      api.api('DELETE', `/users/${other}/stores/${created.body.id}`),
      api.api('GET', `/users/${other}/pos`),
    ]) {
      expect((await call).status).toBe(404);
    }

    const still = await api.api('GET', `/users/${collector}/stores/search`);
    expect(still.body.paging.total).toBe(1);
  });

  test('an unknown store is a 404', async () => {
    const { api, collector } = await start();
    expect((await api.api('GET', '/stores/99999999')).status).toBe(404);
    expect((await api.api('DELETE', `/users/${collector}/stores/99999999`)).status).toBe(404);
    expect((await api.api('PUT', `/users/${collector}/stores/99999999`, { body: store() })).status).toBe(404);
  });
});

describe('points of sale', () => {
  const newStore = async (api: TestServer, collector: number, externalId: string) => {
    const created = await api.api('POST', `/users/${collector}/stores`, {
      body: store({ external_id: externalId }),
    });
    return created.body.id as string;
  };

  test('creates a POS under a store and lists it', async () => {
    const { api, collector } = await start();
    const storeId = await newStore(api, collector, 'L1');

    const created = await api.api('POST', '/pos', {
      body: {
        name: 'Caixa 1',
        store_id: storeId,
        external_id: 'CAIXA1',
        external_store_id: 'L1',
        category: 621102,
        fixed_amount: true,
      },
    });
    expect(created.status).toBe(201);
    expect(typeof created.body.id).toBe('number');
    expect(created.body.store_id).toBe(storeId);
    expect(created.body.user_id).toBe(collector);
    expect(created.body.status).toBe('active');
    expect(created.body.category).toBe(621102);
    expect(created.body.fixed_amount).toBe(true);
    expect(created.body.external_store_id).toBe('L1');
    expect(created.body.qr.image).toBe(`${api.origin}/pos/${created.body.id}/qr.png`);
    expect(created.body.qr.template_document).toBe(`${api.origin}/pos/${created.body.id}/qr`);
    expect(created.body.qr_code).toBe(created.body.qr.template_document);

    const png = await api.raw(`/pos/${created.body.id}/qr.png`);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await png.arrayBuffer()).slice(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47]));

    const poster = await api.raw(`/pos/${created.body.id}/qr`);
    expect(poster.status).toBe(200);
    expect(poster.headers.get('content-type')).toContain('text/html');
    expect(await poster.text()).toContain('Caixa 1');

    expect((await api.raw('/pos/99999999/qr.png')).status).toBe(404);
    expect((await api.raw('/pos/99999999/qr')).status).toBe(404);

    const read = await api.api('GET', `/pos/${created.body.id}`);
    expect(read.status).toBe(200);
    expect(read.body.name).toBe('Caixa 1');

    const listed = await api.api('GET', `/users/${collector}/pos`);
    expect(listed.body.paging.total).toBe(1);
    expect(listed.body.results[0].id).toBe(created.body.id);
  });

  test('searches by external_id, store, category and status', async () => {
    const { api, collector } = await start();
    const first = await newStore(api, collector, 'L1');
    const second = await newStore(api, collector, 'L2');

    await api.api('POST', '/pos', { body: { name: 'A', store_id: first, external_id: 'A1', category: 1 } });
    await api.api('POST', '/pos', { body: { name: 'B', store_id: second, external_id: 'B1', category: 2 } });
    const third = await api.api('POST', '/pos', { body: { name: 'C', store_id: second, external_id: 'C1' } });

    expect((await api.api('GET', '/pos')).body.paging.total).toBe(3);
    expect((await api.api('GET', '/pos?external_id=B1')).body.results[0].name).toBe('B');
    expect((await api.api('GET', `/pos?store_id=${second}`)).body.paging.total).toBe(2);
    expect((await api.api('GET', '/pos?category=2')).body.paging.total).toBe(1);
    expect((await api.api('GET', '/pos?external_store_id=nothing')).body.paging.total).toBe(0);
    // A client interpolating an unset variable must not match the POS that have no category.
    expect((await api.api('GET', '/pos?category=null')).body.paging.total).toBe(0);

    const off = await api.api('PUT', `/pos/${third.body.id}`, { body: { status: 'inactive' } });
    expect(off.status).toBe(200);
    expect(off.body.status).toBe('inactive');
    expect(off.body.name).toBe('C');
    expect((await api.api('GET', '/pos?status=inactive')).body.paging.total).toBe(1);
    expect((await api.api('GET', '/pos?status=active')).body.paging.total).toBe(2);
  });

  test('updates and rejects invalid or duplicate input', async () => {
    const { api, collector } = await start();
    const storeId = await newStore(api, collector, 'L1');

    const created = await api.api('POST', '/pos', {
      body: { name: 'Caixa 1', store_id: storeId, external_id: 'CAIXA1' },
    });

    const renamed = await api.api('PUT', `/pos/${created.body.id}`, {
      body: { name: 'Caixa renomeada', category: 7, fixed_amount: true },
    });
    expect(renamed.body.name).toBe('Caixa renomeada');
    expect(renamed.body.category).toBe(7);
    expect(renamed.body.external_id).toBe('CAIXA1');

    expect((await api.api('POST', '/pos', { body: { name: 'x' } })).status).toBe(400);
    expect((await api.api('POST', '/pos', { body: { name: 'x', store_id: '404' } })).status).toBe(400);
    expect(
      (await api.api('POST', '/pos', { body: { name: 'x', store_id: storeId, category: 'high' } })).status,
    ).toBe(400);

    const duplicate = await api.api('POST', '/pos', {
      body: { name: 'Caixa 2', store_id: storeId, external_id: 'CAIXA1' },
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.cause[0].code).toBe('point_of_sale_exists');

    expect((await api.api('GET', '/pos/99999999')).status).toBe(404);
    expect((await api.api('PUT', '/pos/99999999', { body: { name: 'x' } })).status).toBe(404);
    expect((await api.api('DELETE', '/pos/99999999')).status).toBe(404);
  });

  test('a store with a point of sale is not deleted', async () => {
    const { api, collector } = await start();
    const storeId = await newStore(api, collector, 'L1');
    const pos = await api.api('POST', '/pos', { body: { name: 'Caixa 1', store_id: storeId } });

    const refused = await api.api('DELETE', `/users/${collector}/stores/${storeId}`);
    expect(refused.status).toBe(400);
    expect(refused.body.cause[0].description).toContain('points of sale');
    expect((await api.api('GET', `/stores/${storeId}`)).status).toBe(200);

    expect((await api.api('DELETE', `/pos/${pos.body.id}`)).status).toBe(200);
    expect((await api.api('GET', `/pos/${pos.body.id}`)).status).toBe(404);

    expect((await api.api('DELETE', `/users/${collector}/stores/${storeId}`)).status).toBe(200);
    expect((await api.api('GET', `/stores/${storeId}`)).status).toBe(404);
  });
});
