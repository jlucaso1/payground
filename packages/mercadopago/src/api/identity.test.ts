import { describe, expect, test } from 'bun:test';
import { type Result, unwrap } from '@payground/core';
import type { ErrorBody } from '../errors.ts';
import type { Rendered } from './context.ts';
import { harness } from './fixture.ts';
import {
  IDENTIFICATION_TYPES,
  type PayerCost,
  createOAuthToken,
  getCollectorUser,
  getInstallments,
  listIdentificationTypes,
  oauthClient,
  refreshTokenFor,
} from './identity.ts';

const failed = (result: Result<Rendered, ErrorBody>): ErrorBody => {
  if (result.ok) throw new Error('expected a failure');
  return result.error;
};

interface Installments {
  payment_method_id: string;
  payment_type_id: string;
  issuer: { id: string | null; name: string };
  payer_costs: PayerCost[];
}

const plan = (query: string): Installments => {
  const body = unwrap(getInstallments(harness().context, new URLSearchParams(query))).body;
  const first = (body as Installments[])[0];
  if (first === undefined) throw new Error('no installments entry');
  return first;
};

describe('listIdentificationTypes', () => {
  test('returns the Brazilian catalogue', () => {
    const response = unwrap(listIdentificationTypes(harness().context));
    expect(response.status).toBe(200);
    expect(response.body).toBe(IDENTIFICATION_TYPES);
    expect(IDENTIFICATION_TYPES.map((entry) => entry.id)).toEqual(['CPF', 'CNPJ']);
  });

  test('every entry carries the fields the real endpoint returns', () => {
    for (const entry of IDENTIFICATION_TYPES) {
      expect(Object.keys(entry).sort()).toEqual(['id', 'max_length', 'min_length', 'name', 'type']);
      expect(entry.type).toBe('number');
      expect(entry.min_length).toBeLessThanOrEqual(entry.max_length);
    }
  });
});

describe('getInstallments', () => {
  test('offers twelve instalments for a credit card', () => {
    const entry = plan('payment_method_id=visa&amount=100');
    expect(entry.payment_method_id).toBe('visa');
    expect(entry.payment_type_id).toBe('credit_card');
    expect(entry.payer_costs).toHaveLength(12);
    expect(entry.payer_costs.map((cost) => cost.installments)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  test('the first six instalments are interest free', () => {
    for (const cost of plan('payment_method_id=visa&amount=100').payer_costs.slice(0, 6)) {
      expect(cost.installment_rate).toBe(0);
      expect(cost.installment_amount).toBe(Math.round(10_000 / cost.installments) / 100);
      expect(cost.total_amount).toBe((Math.round(10_000 / cost.installments) * cost.installments) / 100);
    }
  });

  test('instalments above six carry interest and grow with the count', () => {
    const costs = plan('payment_method_id=master&amount=1000').payer_costs;
    const financed = costs.slice(6);
    expect(financed[0]?.installment_rate).toBeGreaterThan(0);
    for (let index = 1; index < financed.length; index += 1) {
      expect(financed[index]?.installment_rate ?? 0).toBeGreaterThan(financed[index - 1]?.installment_rate ?? 0);
    }
  });

  test('the total is the instalment multiplied by the count', () => {
    for (const cost of plan('payment_method_id=visa&amount=999.99').payer_costs) {
      expect(Math.round(cost.installment_amount * cost.installments * 100)).toBe(
        Math.round(cost.total_amount * 100),
      );
    }
  });

  test('formats the recommended message in Brazilian notation', () => {
    const costs = plan('payment_method_id=visa&amount=1234.5').payer_costs;
    expect(costs[0]?.recommended_message).toBe('1 parcela de R$ 1.234,50 (R$ 1.234,50)');
    expect(costs[1]?.recommended_message).toBe('2 parcelas de R$ 617,25 (R$ 1.234,50)');
    expect(costs[0]?.labels).toEqual(['CFT_0,00%|TEA_0,00%']);
  });

  test('a non-card method is a single upfront instalment', () => {
    const entry = plan('payment_method_id=pix&amount=50');
    expect(entry.payment_type_id).toBe('bank_transfer');
    expect(entry.payer_costs).toHaveLength(1);
    expect(entry.issuer.id).toBeNull();
  });

  test('debit is never financed', () => {
    expect(plan('payment_method_id=debvisa&amount=100').payer_costs).toHaveLength(1);
  });

  test('drops the instalments that fall below the catalogue minimum', () => {
    const context = harness().context;
    const costs = plan('payment_method_id=visa&amount=2').payer_costs;
    expect(costs.map((cost) => cost.installments)).toEqual([1, 2, 3, 4]);
    expect(costs.every((cost) => cost.installment_amount >= 0.5)).toBe(true);

    const none = unwrap(getInstallments(context, new URLSearchParams('payment_method_id=visa&amount=0.01')));
    expect(none.body).toEqual([]);
  });

  test('the issuer_id on the query wins, unless it is blank', () => {
    expect(plan('payment_method_id=visa&amount=10&issuer_id=3000').issuer.id).toBe('3000');
    expect(plan('payment_method_id=visa&amount=10&issuer_id=').issuer.id).toBe('1');
  });

  test('rejects a missing or unknown payment method', () => {
    const context = harness().context;
    expect(failed(getInstallments(context, new URLSearchParams('amount=10'))).status).toBe(400);
    expect(
      failed(getInstallments(context, new URLSearchParams('payment_method_id=nope&amount=10'))).message,
    ).toContain('nope');
  });

  test('rejects an amount that is not a positive decimal', () => {
    const context = harness().context;
    for (const query of [
      'payment_method_id=visa',
      'payment_method_id=visa&amount=',
      'payment_method_id=visa&amount=abc',
      'payment_method_id=visa&amount=0',
      'payment_method_id=visa&amount=-5',
      'payment_method_id=visa&amount=1.005',
      'payment_method_id=visa&amount=100001',
    ]) {
      expect(failed(getInstallments(context, new URLSearchParams(query))).status).toBe(400);
    }
  });
});

describe('createOAuthToken', () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    client_id: 'app-1',
    client_secret: 'TEST-token',
    code: 'TG-code',
    redirect_uri: 'https://merchant.example/callback',
    grant_type: 'authorization_code',
    ...overrides,
  });

  test('exchanges an authorization code for the sandbox credentials', () => {
    const { context } = harness();
    const response = unwrap(createOAuthToken(context, body()));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      access_token: context.sandbox.accessToken,
      token_type: 'bearer',
      expires_in: 15_552_000,
      scope: 'offline_access read write',
      user_id: context.collectorId,
      refresh_token: refreshTokenFor(context),
      public_key: context.sandbox.publicKey,
      live_mode: false,
    });
  });

  test('the refresh token is stable and accepted by the refresh grant', () => {
    const { context } = harness();
    const refreshed = unwrap(
      createOAuthToken(context, {
        client_id: 'app-1',
        client_secret: 'TEST-token',
        grant_type: 'refresh_token',
        refresh_token: refreshTokenFor(context),
      }),
    );
    expect((refreshed.body as { access_token: string }).access_token).toBe(context.sandbox.accessToken);
    expect(refreshTokenFor(context)).toBe(refreshTokenFor(harness().context));
    expect(refreshTokenFor(context)).toStartWith('TG-');
  });

  test('rejects an unknown refresh token', () => {
    const error = failed(
      createOAuthToken(harness().context, { grant_type: 'refresh_token', refresh_token: 'TG-nope' }),
    );
    expect([error.status, error.error]).toEqual([400, 'invalid_grant']);
  });

  test('rejects a missing code and an unsupported grant', () => {
    const { context } = harness();
    expect(failed(createOAuthToken(context, body({ code: undefined }))).error).toBe('invalid_grant');
    expect(failed(createOAuthToken(context, body({ grant_type: 'password' }))).error).toBe(
      'unsupported_grant_type',
    );
    expect(failed(createOAuthToken(context, body({ grant_type: undefined }))).error).toBe(
      'unsupported_grant_type',
    );
    expect(failed(createOAuthToken(context, 'nope')).error).toBe('invalid_request');
  });
});

describe('oauthClient', () => {
  test('falls back to the bearer token as the client secret', () => {
    expect(unwrap(oauthClient({ client_id: 'app-1' }, 'TEST-token'))).toEqual({
      clientId: 'app-1',
      clientSecret: 'TEST-token',
    });
  });

  test('the body wins over the bearer token', () => {
    expect(
      unwrap(oauthClient({ client_id: 'app-1', client_secret: 'TEST-other' }, 'TEST-token')).clientSecret,
    ).toBe('TEST-other');
  });

  test('demands both credentials', () => {
    const missingId = oauthClient({ client_secret: 'TEST-token' }, null);
    expect(missingId.ok ? null : missingId.error.error).toBe('invalid_client');
    const missingSecret = oauthClient({ client_id: 'app-1' }, null);
    expect(missingSecret.ok ? null : missingSecret.error.error).toBe('invalid_client');
  });
});

describe('getCollectorUser', () => {
  test('describes the authenticated collector', () => {
    const { context } = harness();
    const response = unwrap(getCollectorUser(context));
    const user = response.body as { id: number; site_id: string; country_id: string; email: string; identification: { number: string } };
    expect(response.status).toBe(200);
    expect(user.id).toBe(context.collectorId);
    expect([user.site_id, user.country_id]).toEqual(['MLB', 'BR']);
    expect(user.email).toContain(String(context.collectorId));
    expect(user.identification.number).toHaveLength(11);
  });

  test('the derived CPF has valid check digits', () => {
    const { identification } = unwrap(getCollectorUser(harness().context)).body as {
      identification: { number: string };
    };
    const digits = [...identification.number].map(Number);
    for (const length of [9, 10]) {
      const sum = digits
        .slice(0, length)
        .reduce((acc, digit, index) => acc + digit * (length + 1 - index), 0);
      const rest = (sum * 10) % 11;
      expect(digits[length]).toBe(rest === 10 ? 0 : rest);
    }
  });
});
