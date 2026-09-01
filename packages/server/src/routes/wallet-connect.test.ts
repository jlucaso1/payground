import { afterEach, describe, expect, test } from 'bun:test';
import { TEST_ACCESS_TOKEN, type TestServer, startTestServer } from '../testing.ts';

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.stop();
});

const start = (): TestServer => {
  const server = startTestServer();
  servers.push(server);
  return server;
};

const AGREEMENTS = '/v2/wallet_connect/agreements';

const newAgreement = (server: TestServer, body: Record<string, unknown> = {}) =>
  server.api('POST', AGREEMENTS, {
    body: {
      external_flow_id: 'F1',
      return_uri: 'https://shop.example.com/back',
      payer: { email: 'payer@example.com' },
      ...body,
    },
  });

interface WalletCall {
  status: number;
  body: any;
}

/** `server.api` cannot carry `x-payer-token`, so the wallet endpoints are called raw. */
const wallet = async (
  server: TestServer,
  path: string,
  token: string | null,
  body: unknown,
): Promise<WalletCall> => {
  const response = await server.raw(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
      ...(token === null ? {} : { 'x-payer-token': token }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

/** Walks the redirect flow: approval page, authorization, payer token. */
async function authorize(server: TestServer): Promise<{ agreementId: string; code: string; token: string }> {
  const created = await newAgreement(server);
  const agreementId = created.body.id as string;

  const submitted = await server.raw(`/wallet_connect/authorize/${agreementId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=payer@example.com',
    redirect: 'manual',
  });
  const location = new URL(submitted.headers.get('location') ?? '');
  const code = location.searchParams.get('code') ?? '';

  const minted = await server.api('POST', `${AGREEMENTS}/${agreementId}/payer_token`, { body: { code } });
  return { agreementId, code, token: minted.body.payer_token as string };
}

describe('wallet connect agreements', () => {
  test('an agreement starts pending and points at this instance', async () => {
    const server = start();
    const created = await newAgreement(server);

    expect(created.status).toBe(200);
    expect(created.body.status).toBe('pending');
    expect(created.body.external_flow_id).toBe('F1');
    expect(created.body.agreement_id).toBe(created.body.id);
    expect(created.body.agreement_uri).toBe(`${server.origin}/wallet_connect/authorize/${created.body.id}`);
    expect(created.body.payer).toEqual({ email: 'payer@example.com', mp_payer_id: expect.any(Number) });
    expect(created.body.scopes).toEqual(['payment']);
    expect(created.body.date_canceled).toBeNull();

    const fetched = await server.api('GET', `${AGREEMENTS}/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.id).toBe(created.body.id);
  });

  test('the body is validated', async () => {
    const server = start();
    const noFlow = await server.api('POST', AGREEMENTS, { body: { return_uri: 'https://a.example.com' } });
    expect(noFlow.status).toBe(400);
    expect(noFlow.body.cause[0].description).toContain('external_flow_id');

    const badUri = await server.api('POST', AGREEMENTS, { body: { external_flow_id: 'F', return_uri: 'nope' } });
    expect(badUri.status).toBe(400);

    const badEmail = await newAgreement(server, { payer: { email: 'nope' } });
    expect(badEmail.status).toBe(400);
  });

  test('redirect_url is accepted as an alias of return_uri', async () => {
    const server = start();
    const created = await server.api('POST', AGREEMENTS, {
      body: { external_flow_id: 'F1', redirect_url: 'https://shop.example.com/back' },
    });
    expect(created.status).toBe(200);
    expect(created.body.redirect_uri).toBe('https://shop.example.com/back');
    expect(created.body.payer).toBeUndefined();
  });

  test('the approval page serves the sandbox that owns the agreement', async () => {
    const server = start();
    const second = (await server.control('POST', '/_payground/sandboxes', { name: 'other' })).body as {
      accessToken: string;
    };
    const created = await server.api('POST', AGREEMENTS, {
      token: second.accessToken,
      body: { external_flow_id: 'F2', return_uri: 'https://shop.example.com/back' },
    });
    expect(created.status).toBe(200);

    const submitted = await server.raw(`/wallet_connect/authorize/${created.body.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=other@example.com',
      redirect: 'manual',
    });
    expect(submitted.status).toBe(303);

    const fetched = await server.api('GET', `${AGREEMENTS}/${created.body.id}`, { token: second.accessToken });
    expect(fetched.body.status).toBe('active');
  });

  test('a missing agreement is a 404', async () => {
    const server = start();
    const fetched = await server.api('GET', `${AGREEMENTS}/does-not-exist`);
    expect(fetched.status).toBe(404);
    expect(fetched.body.error).toBe('not_found');
  });

  test('the hosted page authorizes the agreement and redirects with a code', async () => {
    const server = start();
    const created = await newAgreement(server);
    const id = created.body.id as string;

    const rendered = await server.raw(`/wallet_connect/authorize/${id}`);
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get('content-type')).toContain('text/html');
    expect(await rendered.text()).toContain('F1');

    const submitted = await server.raw(`/wallet_connect/authorize/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=wallet@example.com',
      redirect: 'manual',
    });
    expect(submitted.status).toBe(303);
    const location = new URL(submitted.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe('https://shop.example.com/back');
    expect(location.searchParams.get('agreement_id')).toBe(id);
    expect(location.searchParams.get('external_flow_id')).toBe('F1');
    expect(location.searchParams.get('code')).not.toBe('');

    const fetched = await server.api('GET', `${AGREEMENTS}/${id}`);
    expect(fetched.body.status).toBe('active');
    expect(fetched.body.payer.email).toBe('wallet@example.com');
  });

  test('a payer token is minted only for an active agreement', async () => {
    const server = start();
    const created = await newAgreement(server);
    const id = created.body.id as string;

    const early = await server.api('POST', `${AGREEMENTS}/${id}/payer_token`, { body: { code: 'x' } });
    expect(early.status).toBe(400);
    expect(early.body.cause[0].description).toBe('agreement is pending');

    const missing = await server.api('POST', `${AGREEMENTS}/nope/payer_token`, { body: {} });
    expect(missing.status).toBe(404);

    const flow = await authorize(server);
    expect(flow.token.startsWith('WCT-')).toBe(true);

    for (const body of [{ code: 'wrong' }, {}]) {
      const rejected = await server.api('POST', `${AGREEMENTS}/${flow.agreementId}/payer_token`, { body });
      expect(rejected.status).toBe(400);
      expect(rejected.body.cause[0].description).toBe('code invalid');
    }
  });

  test('revoking is terminal and invalidates existing payer tokens', async () => {
    const server = start();
    const flow = await authorize(server);

    const revoked = await server.api('DELETE', `${AGREEMENTS}/${flow.agreementId}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe('revoked');
    expect(revoked.body.date_canceled).not.toBeNull();

    const again = await server.api('DELETE', `${AGREEMENTS}/${flow.agreementId}`);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('revoked');

    const minted = await server.api('POST', `${AGREEMENTS}/${flow.agreementId}/payer_token`, {
      body: { code: flow.code },
    });
    expect(minted.status).toBe(400);
    expect(minted.body.cause[0].description).toBe('agreement is revoked');

    const used = await wallet(server, '/v2/wallet_connect/coupons', flow.token, { id: 'ANY' });
    expect(used.status).toBe(401);

    const reauthorize = await server.raw(`/wallet_connect/authorize/${flow.agreementId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=payer@example.com',
      redirect: 'manual',
    });
    expect(reauthorize.status).toBe(410);
  });

  test('an expired agreement no longer mints tokens', async () => {
    const server = start();
    const created = await newAgreement(server);
    server.clock.advance(31 * 86_400_000);

    const fetched = await server.api('GET', `${AGREEMENTS}/${created.body.id}`);
    expect(fetched.body.status).toBe('expired');

    const minted = await server.api('POST', `${AGREEMENTS}/${created.body.id}/payer_token`, { body: { code: 'x' } });
    expect(minted.status).toBe(400);
    expect(minted.body.cause[0].description).toBe('agreement is expired');

    // Expiry is terminal too: revoking cannot rewrite it.
    const revoked = await server.api('DELETE', `${AGREEMENTS}/${created.body.id}`);
    expect(revoked.status).toBe(400);
  });
});

describe('wallet connect discounts and coupons', () => {
  const register = (server: TestServer, token: string, body: Record<string, unknown>) =>
    wallet(server, '/v2/wallet_connect/discounts', token, body);

  test('the payer token is required', async () => {
    const server = start();
    const anonymous = await register(server, null as unknown as string, { coupon: 'X', amount: 10 });
    expect(anonymous.status).toBe(401);

    const unknown = await register(server, 'WCT-nope', { coupon: 'X', amount: 10 });
    expect(unknown.status).toBe(401);
  });

  test('a fixed campaign is registered, quoted and validated', async () => {
    const server = start();
    const { token } = await authorize(server);

    const created = await register(server, token, {
      coupon: 'welcome10',
      discount_amount: 10,
      max_uses: 1,
      description: 'Welcome',
    });
    expect(created.status).toBe(201);
    const campaign = created.body;
    expect(campaign.coupon_id).toBe('WELCOME10');
    expect(campaign.type).toBe('fixed');
    expect(campaign.amount).toBe(10);

    const duplicate = await register(server, token, { coupon: 'WELCOME10', discount_amount: 5 });
    expect(duplicate.status).toBe(400);

    const validated = await wallet(server, '/v2/wallet_connect/coupons', token, { id: 'WELCOME10', amount: 30 });
    expect(validated.status).toBe(200);
    const validation = validated.body;
    expect(validation.status).toBe('active');
    expect(validation.description).toBe('Welcome');
    expect(validation.detail.discount).toEqual({ amount: 10, transaction_amount: 20, type: 'fixed' });
    expect(validation.detail.uses).toBe(0);

    const quoted = await register(server, token, { coupon: 'WELCOME10', amount: 30 });
    expect(quoted.status).toBe(200);
    const promise = quoted.body;
    expect(promise).toEqual({
      transaction_amount: 20,
      currency_id: 'BRL',
      legal_terms: expect.any(String),
      discount: { amount: 10, type: 'fixed', coupon_id: 'WELCOME10' },
    });

    // max_uses is spent by the promise, not by validation.
    const exhausted = await wallet(server, '/v2/wallet_connect/coupons', token, { id: 'WELCOME10' });
    expect(exhausted.body.status).toBe('inactive');
    const again = await register(server, token, { coupon: 'WELCOME10', amount: 30 });
    expect(again.status).toBe(400);
    expect(again.body.cause[0].description).toBe('coupon is inactive');
  });

  test('a percentage campaign is capped and never exceeds the purchase', async () => {
    const server = start();
    const { token } = await authorize(server);

    const created = await register(server, token, { coupon: 'HALF', discount_percentage: 12.5, cap: 5 });
    expect(created.status).toBe(201);
    expect(created.body.percentage).toBe(12.5);

    const small = await register(server, token, { coupon: 'HALF', amount: 10 });
    expect(small.body.discount).toEqual({ amount: 1.25, type: 'percentage', coupon_id: 'HALF' });

    const capped = await register(server, token, { coupon: 'HALF', amount: 100 });
    expect(capped.body).toMatchObject({
      transaction_amount: 95,
      discount: { amount: 5, type: 'percentage' },
    });
  });

  test('a validity window comes from the clock', async () => {
    const server = start();
    const { token } = await authorize(server);
    const from = new Date(server.clock.now() + 60_000).toISOString();
    const to = new Date(server.clock.now() + 120_000).toISOString();

    const created = await register(server, token, {
      coupon: 'LATER',
      discount_amount: 1,
      valid_from: from,
      valid_to: to,
    });
    expect(created.status).toBe(201);

    const early = await wallet(server, '/v2/wallet_connect/coupons', token, { id: 'LATER' });
    expect(early.body.status).toBe('inactive');

    server.clock.advance(90_000);
    const live = await wallet(server, '/v2/wallet_connect/coupons', token, { id: 'LATER' });
    expect(live.body.status).toBe('active');

    server.clock.advance(60_000);
    const late = await wallet(server, '/v2/wallet_connect/coupons', token, { id: 'LATER' });
    expect(late.body.status).toBe('expired');
    const rejected = await register(server, token, { coupon: 'LATER', amount: 10 });
    expect(rejected.status).toBe(400);
    expect(rejected.body.cause[0].description).toBe('coupon is expired');
  });

  test('an unknown coupon and a bad window are rejected', async () => {
    const server = start();
    const { token } = await authorize(server);

    const unknown = await wallet(server, '/v2/wallet_connect/coupons', token, { id: 'GHOST' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.cause[0].description).toBe('coupon not found');

    const window = await register(server, token, {
      coupon: 'BAD',
      discount_amount: 1,
      valid_from: new Date(server.clock.now() + 120_000).toISOString(),
      valid_to: new Date(server.clock.now() + 60_000).toISOString(),
    });
    expect(window.status).toBe(400);

    const both = await register(server, token, { coupon: 'BOTH', discount_amount: 1, discount_percentage: 10 });
    expect(both.status).toBe(400);

    const cents = await register(server, token, { coupon: 'CENTS', discount_amount: 1.005 });
    expect(cents.status).toBe(400);
  });
});
