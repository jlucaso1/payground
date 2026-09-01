import { afterEach, describe, expect, test } from 'bun:test';
import { TEST_ACCESS_TOKEN, type TestServer, startTestServer } from '../testing.ts';

const WINDOW = { begin_date: '2020-01-01T00:00:00Z', end_date: '2030-01-01T00:00:00Z' };
const GENERATION_MS = 6_000;
const BASE = '/v1/account/settlement_report';

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.stop();
});

function start(): TestServer {
  const app = startTestServer();
  servers.push(app);
  return app;
}

const payment = (app: TestServer, overrides: Record<string, unknown> = {}) =>
  app.api('POST', '/v1/payments', {
    body: {
      transaction_amount: 100.5,
      payment_method_id: 'account_money',
      payer: { email: 'payer@example.com' },
      ...overrides,
    },
  });

/** Creates a report, advances the clock past generation and returns the finished task. */
async function generate(app: TestServer, window = WINDOW) {
  const created = await app.api('POST', BASE, { body: window });
  expect(created.status).toBe(202);
  app.clock.advance(GENERATION_MS);
  const task = await app.api('GET', `${BASE}/task/${created.body.id}`);
  expect(task.body.status).toBe('done');
  return task.body as { id: string; file_name: string; download_url: string };
}

const csv = (app: TestServer, fileName: string) =>
  app.raw(`${BASE}/${encodeURIComponent(fileName)}`, {
    headers: { authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
  });

describe('settlement report over HTTP', () => {
  test('serves the config, honours a partial update and rejects bad input', async () => {
    const app = start();
    expect((await app.api('GET', `${BASE}/config`)).body).toMatchObject({
      file_name_prefix: 'settlement-report',
      column_separator: ',',
    });

    const created = await app.api('POST', `${BASE}/config`, {
      body: { file_name_prefix: 'ledger', column_separator: ';', display_timezone: 'America/Sao_Paulo' },
    });
    expect(created.status).toBe(200);

    const updated = await app.api('PUT', `${BASE}/config`, { body: { notification_email_list: ['ops@example.com'] } });
    expect(updated.body).toMatchObject({
      file_name_prefix: 'ledger',
      column_separator: ';',
      notification_email_list: ['ops@example.com'],
    });

    const rejected = await app.api('POST', `${BASE}/config`, { body: { file_name_prefix: '../escape' } });
    expect(rejected.status).toBe(400);
    expect(rejected.body.cause[0].description).toContain('file_name_prefix');
  });

  test('generates asynchronously and only then serves the file', async () => {
    const app = start();
    await payment(app, { external_reference: 'order-1' });

    const created = await app.api('POST', BASE, { body: WINDOW });
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({ status: 'pending', download_url: null });

    app.clock.advance(1_000);
    const running = await app.api('GET', `${BASE}/task/${created.body.id}`);
    expect(running.body).toMatchObject({ status: 'in_progress', file_name: null });
    expect((await app.api('GET', BASE)).body.results).toEqual([]);

    app.clock.advance(5_000);
    const done = await app.api('GET', `${BASE}/task/${created.body.id}`);
    expect(done.body.status).toBe('done');
    const name: string = done.body.file_name;
    expect(name).toMatch(/^settlement-report-2020-01-01-2030-01-01-[0-9a-f]{32}\.csv$/);
    expect(done.body.download_url).toBe(`${app.origin}${BASE}/${name}`);

    const listed = await app.api('GET', BASE);
    expect(listed.body.results).toMatchObject([{ status: 'available', file_name: name }]);

    const file = await csv(app, name);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(file.headers.get('content-disposition')).toBe(`attachment; filename="${name}"`);

    const [header = '', row = ''] = (await file.text()).split('\r\n');
    expect(header.split(',')[0]).toBe('DATE');
    expect(row.split(',')).toContain('SETTLEMENT');
    expect(row.split(',')).toContain('100.50');
    expect(row.split(',')).toContain('order-1');
  });

  test('an unknown task or file is a 404, and an unauthenticated download a 401', async () => {
    const app = start();
    expect((await app.api('GET', `${BASE}/task/settlement-task-nope`)).status).toBe(404);
    expect((await csv(app, 'nothing.csv')).status).toBe(404);
    expect((await app.raw(`${BASE}/nothing.csv`)).status).toBe(401);
  });

  test('the download runs through the same pipeline as every other operation', async () => {
    const app = start();
    await payment(app);
    const task = await generate(app);

    // Injected faults and the request history are owned by the shared endpoint wrapper.
    const faults = await app.control('PUT', `/_payground/sandboxes/${app.sandboxId}/faults`, { unavailable: true });
    expect(faults.status).toBe(200);
    expect((await csv(app, task.file_name)).status).toBe(503);

    await app.control('PUT', `/_payground/sandboxes/${app.sandboxId}/faults`, { unavailable: false });
    expect((await csv(app, task.file_name)).status).toBe(200);

    const history = app.storage.requests.search({ route: '/v1/account/settlement_report/:id' });
    expect(history.results.map((entry) => entry.status)).toContain(200);
  });

  test('the payload reflects the sandbox payments and refunds', async () => {
    const app = start();
    const created = await payment(app);
    app.clock.advance(1_000);
    const refund = await app.api('POST', `/v1/payments/${created.body.id}/refunds`, { body: { amount: 10.25 } });
    expect(refund.status).toBe(201);
    // A pending payment moved no money, so it must not reach the report.
    await app.api('POST', '/v1/payments', {
      body: { transaction_amount: 42, payment_method_id: 'pix', payer: { email: 'p@example.com' } },
    });

    const task = await generate(app);
    const lines = (await (await csv(app, task.file_name)).text()).split('\r\n').filter((line) => line !== '');
    expect(lines).toHaveLength(3);
    expect(lines[1]?.split(',')[3]).toBe('SETTLEMENT');
    expect(lines[1]?.split(',')[4]).toBe('100.50');
    expect(lines[2]?.split(',')[3]).toBe('REFUND');
    expect(lines[2]?.split(',')[4]).toBe('-10.25');
  });

  test('escapes values carrying the separator, quotes and newlines', async () => {
    const app = start();
    await app.api('POST', `${BASE}/config`, {
      body: { column_separator: ';', columns: [{ key: 'EXTERNAL_REFERENCE', alias: 'ref' }] },
    });
    await payment(app, { external_reference: 'a;b"c\nd' });

    const task = await generate(app);
    expect(await (await csv(app, task.file_name)).text()).toBe('ref\r\n"a;b""c\nd"\r\n');
  });

  test('search filters the generated files and the schedule round-trips', async () => {
    const app = start();
    await generate(app);
    await generate(app, { begin_date: '2021-01-01T00:00:00Z', end_date: '2021-02-01T00:00:00Z' });

    const narrow = await app.api('GET', `${BASE}/search?begin_date=2021-01-01T00:00:00Z&end_date=2021-02-01T00:00:00Z`);
    expect(narrow.body.results).toHaveLength(1);
    expect((await app.api('GET', `${BASE}/search`)).body.results).toHaveLength(2);
    expect((await app.api('GET', `${BASE}/search?begin_date=whenever`)).status).toBe(400);

    expect((await app.api('GET', `${BASE}/list`)).body.results).toEqual([]);
    const enabled = await app.api('POST', `${BASE}/schedule`, { body: { frequency: { type: 'daily', hour: 3 } } });
    expect(enabled.body).toMatchObject({ scheduled: true, frequency: { type: 'daily', hour: 3 } });
    expect((await app.api('GET', `${BASE}/list`)).body.results).toHaveLength(1);

    expect((await app.api('DELETE', `${BASE}/schedule`)).body.scheduled).toBe(false);
    expect((await app.api('GET', `${BASE}/list`)).body.results).toEqual([]);
  });
});
