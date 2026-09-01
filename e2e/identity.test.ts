import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { IdentificationType, MercadoPagoConfig, OAuth, Payment, User } from 'mercadopago';
import { type Harness, startHarness } from './harness.ts';

let harness: Harness;
let config: MercadoPagoConfig;

beforeAll(async () => {
  harness = await startHarness();
  config = new MercadoPagoConfig({ accessToken: harness.sandbox.accessToken });
});
afterAll(async () => {
  await harness.stop();
});

describe('identity through the official SDK', () => {
  test('lists the Brazilian identification types', async () => {
    const types = await new IdentificationType(config).list();
    expect(types.map((type) => type.id)).toEqual(['CPF', 'CNPJ']);
    expect(types[0]).toMatchObject({ type: 'number', min_length: 11, max_length: 11 });
  });

  test('reads the collector profile from /users/me', async () => {
    const me = await new User(config).get();
    expect(me).toMatchObject({ site_id: 'MLB', country_id: 'BR' });
    expect(typeof me.id).toBe('number');
    expect(me.nickname).toContain(String(me.id));

    const payment = await new Payment(config).create({
      body: {
        transaction_amount: 25,
        payment_method_id: 'pix',
        payer: { email: 'payer@example.com', identification: { type: 'CPF', number: '12345678909' } },
      },
    });
    expect(payment.collector_id).toBe(me.id as number);
  });

  test('exchanges an authorization code for a token that authenticates', async () => {
    const token = await new OAuth(config).create({
      body: {
        client_id: 'payground-app',
        client_secret: harness.sandbox.accessToken,
        code: 'TG-authorization-code',
        redirect_uri: 'https://merchant.example/callback',
      },
    });

    expect(token.token_type).toBe('bearer');
    expect(token.live_mode).toBe(false);
    expect(token.public_key).toBe(harness.sandbox.publicKey);
    expect(typeof token.user_id).toBe('number');

    const granted = new Payment(new MercadoPagoConfig({ accessToken: token.access_token as string }));
    const found = await granted.search({ options: { limit: 1 } });
    expect(Array.isArray(found.results)).toBe(true);

    const refreshed = await new OAuth(config).refresh({
      body: {
        client_id: 'payground-app',
        client_secret: harness.sandbox.accessToken,
        refresh_token: token.refresh_token as string,
      },
    });
    expect(refreshed.access_token).toBe(token.access_token as string);
  });
});
