import { describe, expect, test } from 'bun:test';
import { unwrap } from '@payground/core';
import { TEST_CARDS } from '../generated/tables.ts';
import type { CardToken } from '../generated/types.ts';
import { validateCardToken } from '../generated/validate.ts';
import {
  CARD_TOKEN_TTL_MS,
  brandFromBin,
  codesForBrand,
  consumeCardToken,
  createCardToken,
  getCardToken,
  luhn,
} from './card-tokens.ts';
import { cardTokenBody, harness } from './fixture.ts';

const created = (body: unknown = cardTokenBody()) => {
  const app = harness();
  const response = unwrap(createCardToken(app.context, body));
  return { app, response, token: response.body as CardToken };
};

describe('luhn', () => {
  test('accepts every documented test card', () => {
    for (const card of TEST_CARDS) expect(luhn(card.number.replaceAll(' ', ''))).toBe(true);
  });

  test('rejects a mutated digit and non-digits', () => {
    expect(luhn('4235647728025683')).toBe(false);
    expect(luhn('')).toBe(false);
    expect(luhn('42356477280256x2')).toBe(false);
  });
});

describe('brand detection', () => {
  test('classifies the documented test cards', () => {
    const brands = TEST_CARDS.map((card) => brandFromBin(card.number.replaceAll(' ', '').slice(0, 6)));
    expect(brands).toEqual(['master', 'visa', 'amex', 'elo']);
  });

  test('a debit test card prefers the debit catalogue code but accepts the credit one', () => {
    expect(codesForBrand('elo', true)).toEqual({ preferred: 'debelo', allowed: ['elo', 'debelo'] });
    expect(codesForBrand('visa', false)).toEqual({ preferred: 'visa', allowed: ['visa', 'debvisa'] });
    expect(codesForBrand('amex', true)).toEqual({ preferred: 'amex', allowed: ['amex'] });
  });

  test('an unknown prefix has no brand', () => {
    expect(brandFromBin('999999')).toBeNull();
  });
});

describe('createCardToken', () => {
  test('returns a valid CardToken carrying no full PAN', () => {
    const { response, token } = created();

    expect(response.status).toBe(201);
    expect(validateCardToken(token).ok).toBe(true);
    expect(token).toMatchObject({
      first_six_digits: '423564',
      last_four_digits: '5682',
      expiration_month: 11,
      expiration_year: 2030,
      status: 'active',
      luhn_validation: true,
      cardholder: { name: 'APRO', identification: { type: 'CPF', number: '12345678909' } },
    });
    expect(JSON.stringify(token)).not.toContain('4235647728025682');
    expect(token.id).toMatch(/^[0-9a-f]{32}$/);
  });

  test('stores only the bin, last four, expiry and cardholder', () => {
    const { app, token } = created();
    const stored = app.context.store.documents.get('card_token', token.id as string);
    expect(Object.keys(stored?.doc ?? {}).sort()).toEqual([
      'bin',
      'brand',
      'cardholder_name',
      'debit',
      'expiration_month',
      'expiration_year',
      'identification_number',
      'identification_type',
      'last_four',
    ]);
    expect(JSON.stringify(stored)).not.toContain('4235647728025682');
    expect(JSON.stringify(stored)).not.toContain('"123"');
  });

  test('the token expires seven days after creation', () => {
    const { app, token } = created();
    const stored = app.context.store.documents.get('card_token', token.id as string);
    expect((stored?.expiresAt ?? 0) - app.clock.now()).toBe(CARD_TOKEN_TTL_MS);
    expect(token.date_due).not.toBeUndefined();
  });

  test('accepts a two digit expiry year', () => {
    const { token } = created(cardTokenBody({ expiration_year: 30 }));
    expect(token.expiration_year).toBe(2030);
  });

  test('accepts any Luhn valid number, not just the documented cards', () => {
    const { response } = created(cardTokenBody({ card_number: '4539578763621486' }));
    expect(response.status).toBe(201);
  });

  test('rejects invalid card data with the provider error envelope', () => {
    const cases: [Record<string, unknown>, string][] = [
      [cardTokenBody({ card_number: '4235647728025683' }), 'Luhn'],
      [cardTokenBody({ card_number: '1234' }), '13 and 19 digits'],
      [cardTokenBody({ card_number: '9999999999999995' }), 'unsupported brand'],
      [cardTokenBody({ expiration_month: 13 }), 'expiration_month'],
      [cardTokenBody({ expiration_year: 2001 }), 'expired'],
      [cardTokenBody({ security_code: '12' }), 'security_code'],
      [cardTokenBody({ cardholder: { name: '  ' } }), 'cardholder.name'],
      [cardTokenBody({ card_number: undefined }), 'required'],
    ];

    for (const [body, hint] of cases) {
      const app = harness();
      const result = createCardToken(app.context, body);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.status).toBe(400);
      expect(JSON.stringify(result.error.cause)).toContain(hint);
    }
  });

  test('amex needs a four digit security code', () => {
    const amex = cardTokenBody({ card_number: '3753 651535 56885', security_code: '1234' });
    expect(unwrap(createCardToken(harness().context, amex)).status).toBe(201);

    const short = createCardToken(harness().context, { ...amex, security_code: '123' });
    expect(short.ok).toBe(false);
  });
});

describe('getCardToken', () => {
  test('reads a token back', () => {
    const { app, token } = created();
    const read = unwrap(getCardToken(app.context, token.id as string));
    expect(read.status).toBe(200);
    expect(read.body).toEqual(token);
  });

  test('an unknown token is a 404 in the provider envelope', () => {
    const app = harness();
    const missing = getCardToken(app.context, 'nope');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatchObject({ error: 'not_found', status: 404 });
  });

  test('reports the token as expired once its deadline passes', () => {
    const { app, token } = created();
    app.clock.advance(CARD_TOKEN_TTL_MS);
    expect((unwrap(getCardToken(app.context, token.id as string)).body as CardToken).status).toBe('expired');
  });

  test('reports the token as used after a consumption', () => {
    const { app, token } = created();
    expect(consumeCardToken(app.context, token.id as string).ok).toBe(true);
    expect((unwrap(getCardToken(app.context, token.id as string)).body as CardToken).status).toBe('used');
  });
});

describe('consumeCardToken', () => {
  test('is single use', () => {
    const { app, token } = created();
    expect(consumeCardToken(app.context, token.id as string).ok).toBe(true);
    const again = consumeCardToken(app.context, token.id as string);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(JSON.stringify(again.error.cause)).toContain('already used');
  });

  test('refuses an expired token without consuming it', () => {
    const { app, token } = created();
    app.clock.advance(CARD_TOKEN_TTL_MS);
    const result = consumeCardToken(app.context, token.id as string);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error.cause)).toContain('expired');
    expect(app.context.store.documents.get('card_token', token.id as string)?.status).toBe('active');
  });

  test('refuses an unknown token', () => {
    const app = harness();
    const result = consumeCardToken(app.context, 'nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(400);
  });

  test('resolves the card without the PAN', () => {
    const { app, token } = created();
    const resolved = unwrap(consumeCardToken(app.context, token.id as string));
    expect(resolved).toEqual({
      card: { bin: '423564', lastFour: '5682', expiryMonth: 11, expiryYear: 2030, holderName: 'APRO', brand: 'visa' },
      debit: false,
    });
  });
});
