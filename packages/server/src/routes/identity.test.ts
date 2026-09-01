import { afterEach, describe, expect, test } from 'bun:test';
import { TEST_ACCESS_TOKEN, TEST_PUBLIC_KEY, type TestServer, startTestServer } from '../testing.ts';

let server: TestServer;
afterEach(async () => {
  await server.stop();
});

const start = (): TestServer => {
  server = startTestServer();
  return server;
};

const exchange = (body: unknown, headers: Record<string, string> = {}) =>
  server.raw('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('identity routes', () => {
  test('lists identification types', async () => {
    const { body, status } = await start().api('GET', '/v1/identification_types');
    expect(status).toBe(200);
    expect(body.map((entry: { id: string }) => entry.id)).toEqual(['CPF', 'CNPJ']);
  });

  test('the identification types need a token', async () => {
    expect((await start().api('GET', '/v1/identification_types', { token: null })).status).toBe(401);
  });

  test('computes an instalment plan', async () => {
    const { body, status } = await start().api(
      'GET',
      '/v1/payment_methods/installments?payment_method_id=visa&amount=100',
    );
    expect(status).toBe(200);
    expect(body[0].payer_costs).toHaveLength(12);
    expect(body[0].payer_costs[0].recommended_message).toBe('1 parcela de R$ 100,00 (R$ 100,00)');
  });

  test('reports the collector profile the rest of the API uses', async () => {
    const me = await start().api('GET', '/users/me');
    expect(me.status).toBe(200);
    expect([me.body.site_id, me.body.country_id]).toEqual(['MLB', 'BR']);

    const payment = await server.api('POST', '/v1/payments', {
      body: {
        transaction_amount: 10,
        payment_method_id: 'pix',
        payer: { email: 'payer@example.com', identification: { type: 'CPF', number: '12345678909' } },
      },
    });
    expect(payment.body.collector_id).toBe(me.body.id);
  });

  test('the minted access token authenticates the sandbox', async () => {
    start();
    const response = await exchange({
      client_id: 'app-1',
      client_secret: TEST_ACCESS_TOKEN,
      code: 'TG-authorization-code',
      grant_type: 'authorization_code',
    });
    const token = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      public_key: string;
      token_type: string;
      expires_in: number;
      user_id: number;
      live_mode: boolean;
    };

    expect(response.status).toBe(200);
    expect([token.token_type, token.public_key, token.live_mode]).toEqual(['bearer', TEST_PUBLIC_KEY, false]);
    expect(token.expires_in).toBeGreaterThan(0);
    expect((await server.api('GET', '/v1/payments/search', { token: token.access_token })).status).toBe(200);

    const refreshed = await exchange({
      client_id: 'app-1',
      client_secret: TEST_ACCESS_TOKEN,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    });
    expect(refreshed.status).toBe(200);
    expect(((await refreshed.json()) as { access_token: string }).access_token).toBe(token.access_token);
  });

  test('accepts a form encoded body and the bearer token as the secret', async () => {
    start();
    const response = await server.raw('/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
      },
      body: new URLSearchParams({ client_id: 'app-1', grant_type: 'authorization_code', code: 'c' }).toString(),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { access_token: string }).access_token).toBe(TEST_ACCESS_TOKEN);
  });

  test('rejects an unknown client secret and a missing client id', async () => {
    start();
    const unknown = await exchange({ client_id: 'app-1', client_secret: 'TEST-nope', code: 'c' });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toBe('invalid_client');

    const anonymous = await exchange({ client_secret: TEST_ACCESS_TOKEN, code: 'c' });
    expect(anonymous.status).toBe(400);
    expect(((await anonymous.json()) as { error: string }).error).toBe('invalid_client');
  });
});
