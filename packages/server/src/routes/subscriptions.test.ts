import { afterEach, describe, expect, test } from 'bun:test';
import { type TestServer, startTestServer } from '../testing.ts';

let app: TestServer | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

const plan = {
  reason: 'Monthly plan',
  auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: 29.9, currency_id: 'BRL' },
  back_url: 'https://shop.example.com/back',
};

async function seeded(): Promise<{ server: TestServer; collectorId: number }> {
  const server = startTestServer();
  app = server;

  const created = await server.api('POST', '/preapproval_plan', { body: plan });
  await server.api('POST', '/preapproval', {
    body: {
      preapproval_plan_id: created.body.id,
      payer_email: 'subscriber@example.com',
      external_reference: 'SUB-1',
      back_url: 'https://shop.example.com/back',
      card_token_id: 'tok',
    },
  });
  await server.api('POST', '/preapproval', {
    body: {
      preapproval_plan_id: created.body.id,
      payer_email: 'second, "quoted"@example.com',
      external_reference: 'SUB-2',
      back_url: 'https://shop.example.com/back',
    },
  });

  const me = await server.api('GET', '/users/me');
  return { server, collectorId: me.body.id as number };
}

describe('subscription export', () => {
  test('renders the matching subscriptions as CSV', async () => {
    const { server, collectorId } = await seeded();
    const response = await server.raw(`/preapproval/export?collector_id=${collectorId}`, {
      headers: { authorization: 'Bearer TEST-access-token' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toContain(`preapproval-${collectorId}.csv`);

    const lines = (await response.text()).trimEnd().split('\n');
    expect(lines[0]).toBe(
      'id,status,reason,external_reference,payer_email,preapproval_plan_id,transaction_amount,currency_id,frequency,frequency_type,date_created,last_modified,next_payment_date',
    );
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).toContain('SUB-1');
    expect(lines.join('\n')).toContain('29.9');
  });

  test('quotes a value that carries the separator or a quote', async () => {
    const { server, collectorId } = await seeded();
    const body = await (
      await server.raw(`/preapproval/export?collector_id=${collectorId}`, {
        headers: { authorization: 'Bearer TEST-access-token' },
      })
    ).text();
    expect(body).toContain('"second, ""quoted""@example.com"');
  });

  test('filters the export the same way the search does', async () => {
    const { server, collectorId } = await seeded();
    const filtered = await server.raw(
      `/preapproval/export?collector_id=${collectorId}&status=authorized`,
      { headers: { authorization: 'Bearer TEST-access-token' } },
    );
    const lines = (await filtered.text()).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('SUB-1');
  });

  test('requires the collector id and refuses another collector', async () => {
    const { server, collectorId } = await seeded();
    const missing = await server.raw('/preapproval/export', {
      headers: { authorization: 'Bearer TEST-access-token' },
    });
    expect(missing.status).toBe(400);
    await missing.text();

    const foreign = await server.raw(`/preapproval/export?collector_id=${collectorId + 1}`, {
      headers: { authorization: 'Bearer TEST-access-token' },
    });
    expect(foreign.status).toBe(404);
    await foreign.text();
  });

  test('is refused without credentials', async () => {
    const { server, collectorId } = await seeded();
    const response = await server.raw(`/preapproval/export?collector_id=${collectorId}`);
    expect(response.status).toBe(401);
    await response.text();
  });
});
