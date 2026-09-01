import { describe, expect, test } from 'bun:test';
import { normaliseRoute } from './handler.ts';

describe('route label', () => {
  test('collapses identifiers so metric cardinality stays bounded', () => {
    expect(normaliseRoute('/v1/payments/1000000001')).toBe('/v1/payments/:id');
    expect(normaliseRoute('/v1/payments/1000000001/refunds')).toBe('/v1/payments/:id/refunds');
    expect(normaliseRoute('/checkout/393855194-2a7b1bf8-1485-4e86-b9d4-e40d624a5580')).toBe('/checkout/:id');
    expect(normaliseRoute('/v1/card_tokens/0123456789abcdef0123456789abcdef')).toBe('/v1/card_tokens/:id');
  });

  test('leaves real path segments alone', () => {
    expect(normaliseRoute('/v1/payments/search')).toBe('/v1/payments/search');
    expect(normaliseRoute('/v1/payment_methods')).toBe('/v1/payment_methods');
    expect(normaliseRoute('/preapproval_plan/search')).toBe('/preapproval_plan/search');
    expect(normaliseRoute('/')).toBe('/');
  });
});
