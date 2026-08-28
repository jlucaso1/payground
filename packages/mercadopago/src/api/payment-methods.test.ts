import { describe, expect, test } from 'bun:test';
import { unwrap } from '@payground/core';
import { CARD_BRANDS, methodKind } from './methods.ts';
import { PAYMENT_METHODS, listPaymentMethods } from './payment-methods.ts';
import { harness } from './fixture.ts';

describe('listPaymentMethods', () => {
  test('returns the Brazilian catalogue', () => {
    const response = unwrap(listPaymentMethods(harness().context));
    expect(response.status).toBe(200);
    expect((response.body as { id: string }[]).map((entry) => entry.id)).toEqual([
      'pix',
      'bolbradesco',
      'visa',
      'master',
      'amex',
      'elo',
      'hipercard',
      'debvisa',
      'debmaster',
      'account_money',
    ]);
  });

  test('every entry carries the fields the real endpoint returns', () => {
    for (const entry of PAYMENT_METHODS) {
      expect(Object.keys(entry).sort()).toEqual([
        'accreditation_time',
        'additional_info_needed',
        'deferred_capture',
        'financial_institutions',
        'id',
        'max_allowed_amount',
        'min_allowed_amount',
        'name',
        'payment_type_id',
        'processing_modes',
        'secure_thumbnail',
        'settings',
        'status',
        'thumbnail',
      ]);
      expect(entry.status).toBe('active');
      expect(entry.min_allowed_amount).toBeLessThan(entry.max_allowed_amount);
      expect(entry.secure_thumbnail).toStartWith('https://');
    }
  });

  test('every advertised id is a method payground can actually create', () => {
    for (const entry of PAYMENT_METHODS) expect(methodKind(entry.id)).not.toBeNull();
  });

  test('card entries expose bin, length and security code settings', () => {
    for (const entry of PAYMENT_METHODS) {
      if (!CARD_BRANDS.includes(entry.id)) continue;
      const settings = entry.settings[0];
      expect(settings).toBeDefined();
      expect(settings?.card_number.length).toBeGreaterThan(12);
      expect(settings?.security_code.length).toBeGreaterThan(2);
      expect(new RegExp(settings?.bin.pattern ?? '').source).toBeDefined();
    }
  });

  test('only credit cards support deferred capture', () => {
    for (const entry of PAYMENT_METHODS) {
      const expected = entry.payment_type_id === 'credit_card' ? 'supported' : 'does_not_apply';
      expect(entry.deferred_capture).toBe(expected);
    }
  });
});
