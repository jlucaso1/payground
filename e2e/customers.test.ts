import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Customer, MercadoPagoConfig } from 'mercadopago';
import { type Harness, startHarness } from './harness.ts';

let harness: Harness;
let customers: Customer;

beforeAll(async () => {
  harness = await startHarness();
  customers = new Customer(new MercadoPagoConfig({ accessToken: harness.sandbox.accessToken }));
});
afterAll(async () => {
  await harness.stop();
});

/** The SDK types the card expiry as a string, which the API rejects, so tokenise over HTTP. */
const tokenId = async (): Promise<string> => {
  const response = await fetch(`${harness.url}/v1/card_tokens`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${harness.sandbox.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      card_number: '4235647728025682',
      expiration_month: 11,
      expiration_year: 2030,
      security_code: '123',
      cardholder: { name: 'APRO', identification: { type: 'CPF', number: '12345678909' } },
    }),
  });
  const body = (await response.json()) as { id?: string };
  if (body.id === undefined) throw new Error(`tokenisation failed: ${JSON.stringify(body)}`);
  return body.id;
};

/** The SDK has no address client, so the address endpoints are driven over plain HTTP. */
const addresses = async (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${harness.url}/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${harness.sandbox.accessToken}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });

describe('customers through the official SDK', () => {
  test('creates, searches, saves a card and manages an address', async () => {
    const email = 'buyer@example.com';
    const created = await customers.create({
      body: { email, first_name: 'Ada', last_name: 'Lovelace' },
    });
    expect(created.id).toBeString();
    const customerId = created.id as string;

    const found = await customers.search({ options: { email } });
    expect(found.results?.map((customer) => customer.id)).toEqual([customerId]);

    const card = await customers.createCard({ customerId, body: { token: await tokenId() } });
    expect(card).toMatchObject({ first_six_digits: '423564', last_four_digits: '5682' });
    const cardId = card.id as string;

    const listed = await customers.listCards({ customerId });
    expect(listed.map((entry) => entry.id)).toEqual([cardId]);

    const reread = await customers.get({ customerId });
    expect(reread.default_card).toBe(cardId);

    const address = (await (
      await addresses(`/customers/${customerId}/addresses`, {
        method: 'POST',
        body: JSON.stringify({ zip_code: '01310100', street_name: 'Avenida Paulista', street_number: '1000' }),
      })
    ).json()) as { id: string; street_number: string };
    expect(address.id).toBeString();

    const updated = (await (
      await addresses(`/customers/${customerId}/addresses/${address.id}`, {
        method: 'PUT',
        body: JSON.stringify({ street_number: '1500' }),
      })
    ).json()) as { street_number: string };
    expect(updated.street_number).toBe('1500');

    const list = (await (await addresses(`/customers/${customerId}/addresses`)).json()) as unknown[];
    expect(list).toHaveLength(1);

    expect((await addresses(`/customers/${customerId}/addresses/${address.id}`, { method: 'DELETE' })).status).toBe(
      200,
    );

    await customers.removeCard({ customerId, cardId });
    expect(await customers.listCards({ customerId })).toEqual([]);

    await customers.remove({ customerId });
    const gone = await customers.search({ options: { email } });
    expect(gone.results).toEqual([]);
  });

  test('a duplicate email is rejected', async () => {
    const email = 'duplicate@example.com';
    await customers.create({ body: { email } });
    await expect(customers.create({ body: { email } })).rejects.toMatchObject({ status: 400 });
  });
});
