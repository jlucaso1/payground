import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { assertHistogramsMonotonic, parseExposition } from '../metrics/parse.test-util.ts';
import type { Summary } from '../metrics/index.ts';
import { type TestServer, startReceiver, startTestServer } from '../testing.ts';

let app: TestServer;
beforeEach(() => {
  app = startTestServer();
});
afterEach(() => app.stop());

const pix = { transaction_amount: 100, payment_method_id: 'pix', payer: { email: 'a@b.c' } };

const scrape = async (query = '') => {
  const response = await app.raw(`/_payground/metrics${query}`, {
    headers: { authorization: 'Bearer test-admin-token' },
  });
  return { response, text: await response.text() };
};

describe('GET /_payground/metrics', () => {
  test('requires the admin token', async () => {
    expect((await app.raw('/_payground/metrics')).status).toBe(401);
  });

  test('serves valid Prometheus text', async () => {
    await app.api('POST', '/v1/payments', { body: pix });
    await app.api('GET', '/v1/payments/999999');

    const { response, text } = await scrape();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');

    const parsed = parseExposition(text);
    assertHistogramsMonotonic(parsed);
    expect(parsed.types['payground_api_requests_total']).toBe('counter');
    expect(parsed.types['payground_api_request_duration_ms']).toBe('histogram');
    expect(parsed.types['payground_webhook_queue_depth']).toBe('gauge');
    expect(parsed.types['payground_webhook_deliveries']).toBe('gauge');
    expect(parsed.help['payground_api_requests_total']).toContain('requests');

    const created = parsed.series.find(
      (series) => series.name === 'payground_api_requests_total' && series.labels['status'] === '201',
    );
    expect(created).toMatchObject({ value: 1 });
    expect(created?.labels['route']).toBe('/v1/payments');
    expect(created?.labels['sandbox']).toBe(app.sandboxId);
  });

  test('exposes webhook deliveries by outcome and the queue depth', async () => {
    const receiver = startReceiver();
    try {
      await app.api('POST', '/v1/payments', { body: { ...pix, notification_url: receiver.url } });
      const parsed = parseExposition((await scrape()).text);

      const byStatus = (status: string) =>
        parsed.series.find(
          (series) => series.name === 'payground_webhook_deliveries' && series.labels['status'] === status,
        );
      expect(byStatus('queued')).toMatchObject({ value: 1 });
      expect(byStatus('queued')?.labels['sandbox']).toBe(app.sandboxId);
      expect(byStatus('delivered')).toMatchObject({ value: 0 });
      expect(parsed.series.find((series) => series.name === 'payground_webhook_queue_depth')?.value).toBe(1);

      await app.drainWebhooks();
      const after = parseExposition((await scrape()).text);
      expect(after.series.find((series) => series.name === 'payground_webhook_queue_depth')?.value).toBe(0);
      expect(
        after.series.find(
          (series) => series.name === 'payground_webhook_deliveries' && series.labels['status'] === 'delivered',
        ),
      ).toMatchObject({ value: 1 });
    } finally {
      await receiver.stop();
    }
  });

  test('format=json returns totals, per-route counts and estimated quantiles', async () => {
    await app.api('POST', '/v1/payments', { body: pix });
    await app.api('GET', '/v1/payments/999999');

    const { response, text } = await scrape('?format=json');
    expect(response.headers.get('content-type')).toContain('application/json');
    const summary = JSON.parse(text) as Summary;
    expect(summary.requests).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.errorRate).toBe(0.5);
    expect(summary.routes.map((route) => route.route).sort()).toEqual(['/v1/payments', '/v1/payments/:id']);
    expect(summary.latency.p50).not.toBeNull();
    expect(summary.latency.p99).toBeGreaterThanOrEqual(summary.latency.p50 as number);
  });

  test('scraping does not count itself', async () => {
    await scrape();
    const summary = JSON.parse((await scrape('?format=json')).text) as Summary;
    expect(summary.requests).toBe(0);
    expect(summary.latency.p50).toBeNull();
  });
});

describe('GET /_payground/sandboxes/:id/metrics', () => {
  test('rolls up one sandbox', async () => {
    const receiver = startReceiver();
    try {
      await app.api('POST', '/v1/payments', { body: { ...pix, notification_url: receiver.url } });
      const call = await app.control('GET', `/_payground/sandboxes/${app.sandboxId}/metrics`);
      expect(call.status).toBe(200);
      expect(call.body).toMatchObject({ sandbox: app.sandboxId, requests: 1, errors: 0, errorRate: 0 });
      expect(call.body.webhooks.queueDepth).toBe(1);
      expect(call.body.webhooks.byStatus.queued).toBe(1);
      expect(call.body.routes[0].route).toBe('/v1/payments');
    } finally {
      await receiver.stop();
    }
  });

  test('an unknown sandbox is a 404', async () => {
    const call = await app.control('GET', '/_payground/sandboxes/sbx_nope/metrics');
    expect(call.status).toBe(404);
  });

  test('requires the admin token', async () => {
    const call = await app.control('GET', `/_payground/sandboxes/${app.sandboxId}/metrics`, undefined, null);
    expect(call.status).toBe(401);
  });
});
