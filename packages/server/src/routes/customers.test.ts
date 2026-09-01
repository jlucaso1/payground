import { afterEach, describe, expect, test } from 'bun:test';
import { type TestServer, startTestServer } from '../testing.ts';

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const start = (): TestServer => {
  server = startTestServer();
  return server;
};

const customer = async (app: TestServer, email = 'buyer@example.com'): Promise<string> => {
  const created = await app.api('POST', '/v1/customers', { body: { email } });
  expect(created.status).toBe(201);
  return created.body.id as string;
};

describe('customer routes', () => {
  test('search is not shadowed by the id route', async () => {
    const app = start();
    const id = await customer(app);

    const found = await app.api('GET', '/v1/customers/search?email=buyer@example.com');
    expect(found.status).toBe(200);
    expect(found.body.results.map((entry: { id: string }) => entry.id)).toEqual([id]);

    expect((await app.api('GET', `/v1/customers/${id}`)).body.id).toBe(id);
  });

  test('the documented /delete path removes the customer', async () => {
    const app = start();
    const id = await customer(app);

    expect((await app.api('DELETE', `/v1/customers/${id}/delete`)).status).toBe(200);
    expect((await app.api('GET', `/v1/customers/${id}`)).status).toBe(404);
  });

  test('cards and addresses are reachable under a customer', async () => {
    const app = start();
    const id = await customer(app);

    const token = await app.api('POST', '/v1/card_tokens', {
      body: {
        card_number: '4235647728025682',
        expiration_month: 11,
        expiration_year: 2030,
        security_code: '123',
        cardholder: { name: 'APRO', identification: { type: 'CPF', number: '12345678909' } },
      },
    });
    const card = await app.api('POST', `/v1/customers/${id}/cards`, { body: { token: token.body.id } });
    expect(card.status).toBe(201);
    expect((await app.api('GET', `/v1/customers/${id}/cards`)).body).toHaveLength(1);
    expect((await app.api('GET', `/v1/customers/${id}/cards/${card.body.id}`)).status).toBe(200);
    expect((await app.api('DELETE', `/v1/customers/${id}/cards/${card.body.id}`)).status).toBe(200);

    const address = await app.api('POST', `/v1/customers/${id}/addresses`, { body: { zip_code: '01310100' } });
    expect(address.status).toBe(201);
    expect((await app.api('PUT', `/v1/customers/${id}/addresses/${address.body.id}`, { body: { city: 'SP' } })).body.city).toBe('SP');
    expect((await app.api('GET', `/v1/customers/${id}/addresses/${address.body.id}`)).status).toBe(200);
    expect((await app.api('DELETE', `/v1/customers/${id}/addresses/${address.body.id}`)).status).toBe(200);
  });

  test('every customer route needs the access token', async () => {
    const app = start();
    const id = await customer(app);
    for (const path of [`/v1/customers/${id}`, `/v1/customers/${id}/cards`, `/v1/customers/${id}/addresses`]) {
      expect((await app.api('GET', path, { token: null })).status).toBe(401);
    }
  });
});
