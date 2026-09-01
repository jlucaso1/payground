import { afterAll, describe, expect, test } from 'bun:test';
import { REPORT_BUILD_MS, REPORT_QUEUE_MS } from '@payground/mercadopago/api/reports-release.ts';
import { TEST_ACCESS_TOKEN, startTestServer } from '../testing.ts';

const server = startTestServer();
afterAll(() => server.stop());

const READY = REPORT_QUEUE_MS + REPORT_BUILD_MS;
const ROUTE = '/v1/account/release_report/:file_name';

async function settledPayment(amount: number, description: string): Promise<number> {
  const created = await server.api('POST', '/v1/payments', {
    body: {
      transaction_amount: amount,
      description,
      payment_method_id: 'pix',
      payer: { email: 'payer@example.com' },
    },
  });
  expect(created.status).toBe(201);
  const sequence = created.body.id as number;

  const listed = await server.control('GET', `/_payground/sandboxes/${server.sandboxId}/payments`);
  const entry = (listed.body.results as { id: string; sequence: number }[]).find(
    (payment) => payment.sequence === sequence,
  );
  const acted = await server.control(
    'POST',
    `/_payground/sandboxes/${server.sandboxId}/payments/${entry?.id ?? ''}/actions`,
    { type: 'settle' },
  );
  expect(acted.status).toBe(200);
  return sequence;
}

async function download(fileName: string): Promise<Response> {
  return server.raw(`/v1/account/release_report/${fileName}`, {
    headers: { authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
  });
}

describe('release reports over HTTP', () => {
  test('generates a report from the sandbox ledger and serves it as CSV', async () => {
    const paymentId = await settledPayment(120.5, 'coffee, "large"');
    const refunded = await settledPayment(80, 'refunded order');
    expect((await server.api('POST', `/v1/payments/${refunded}/refunds`, { body: { amount: 30 } })).status).toBe(201);

    const config = await server.api('PUT', '/v1/account/release_report/config', {
      body: { file_name_prefix: 'staging', separator: ';', display_timezone: 'UTC' },
    });
    expect(config.status).toBe(200);

    const task = await server.api('POST', '/v1/account/release_report', {
      body: { begin_date: '2020-01-01T00:00:00Z', end_date: '2030-01-01T00:00:00Z' },
    });
    expect(task.status).toBe(202);
    expect(task.body.status).toBe('pending');
    expect(task.body.download_url).toBeNull();

    const early = await download(task.body.file_name as string);
    expect(early.status).toBe(404);

    server.clock.advance(READY);
    const polled = await server.api('GET', `/v1/account/release_report/task/${task.body.id as string}`);
    expect(polled.status).toBe(200);
    expect(polled.body.status).toBe('done');
    expect(polled.body.download_url).toContain(task.body.file_name as string);

    const file = await download(task.body.file_name as string);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(file.headers.get('content-disposition')).toBe(
      `attachment; filename="${task.body.file_name as string}"`,
    );

    const lines = (await file.text()).trimEnd().split('\n');
    expect(lines[0]?.split(';')[0]).toBe('RELEASE_DATE');
    expect(lines.length).toBe(4);
    // 120.50 through Pix costs 0.99%, i.e. 1.19 rounded down, so 119.31 is released.
    expect(lines[1]).toContain(`;${paymentId};;release;"coffee, ""large""";120.50;0.00;120.50;0.00;`);
    expect(lines.some((line) => line.includes(';refund;'))).toBe(true);

    const listed = await server.api('GET', '/v1/account/release_report');
    expect(listed.body.results).toHaveLength(1);
    expect(listed.body.results[0].file_name).toBe(task.body.file_name);

    const searched = await server.api(
      'GET',
      '/v1/account/release_report/search?begin_date=2031-01-01T00:00:00Z',
    );
    expect(searched.body.results).toHaveLength(0);
  });

  test('rejects a bad range and an unknown file', async () => {
    const bad = await server.api('POST', '/v1/account/release_report', { body: { begin_date: 'x' } });
    expect(bad.status).toBe(400);
    expect((await download('nope.csv')).status).toBe(404);
    expect((await server.raw('/v1/account/release_report/nope.csv')).status).toBe(401);
  });

  test('the download obeys fault injection and lands in metrics and history', async () => {
    const task = await server.api('POST', '/v1/account/release_report', {
      body: { begin_date: '2020-01-01T00:00:00Z', end_date: '2030-01-01T00:00:00Z' },
    });
    server.clock.advance(READY);
    const fileName = task.body.file_name as string;

    const before = server.storage.requests.search({ route: ROUTE }).total;
    expect((await download(fileName)).status).toBe(200);
    expect(server.storage.requests.search({ route: ROUTE }).total).toBe(before + 1);

    await server.control('PUT', `/_payground/sandboxes/${server.sandboxId}/faults`, { unavailable: true });
    expect((await download(fileName)).status).toBe(503);
    await server.control('PUT', `/_payground/sandboxes/${server.sandboxId}/faults`, { unavailable: false });
  });

  test('enables and disables the schedule', async () => {
    const enabled = await server.api('POST', '/v1/account/release_report/schedule', {
      body: { frequency: { type: 'monthly', hour: 3 } },
    });
    expect(enabled.status).toBe(200);

    const listed = await server.api('GET', '/v1/account/release_report/list');
    expect(listed.body.results[0].frequency).toEqual({ hour: 3, type: 'monthly' });

    expect((await server.api('DELETE', '/v1/account/release_report/schedule')).status).toBe(200);
    expect((await server.api('GET', '/v1/account/release_report/list')).body.results).toHaveLength(0);
  });
});
