import { afterEach, describe, expect, test } from 'bun:test';
import { ManualClock, SeededIdGenerator } from '@payground/core/testing.ts';
import { ROUTES } from '@payground/mercadopago';
import { Storage } from '@payground/storage';
import { createApp } from './app.ts';
import { createServer } from './server.ts';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

const app = () =>
  createApp({
    storage: Storage.open(),
    clock: new ManualClock(1_700_000_000_000),
    ids: new SeededIdGenerator(),
    deliveryIntervalMs: 0,
  });

/** Endpoints deliberately left out of V1. */
const UNIMPLEMENTED = [
  '/v1/customers', '/v1/customers/search', '/v1/customers/{id}', '/v1/customers/{id}/delete',
  '/v1/customers/{customer_id}/cards', '/v1/customers/{customer_id}/cards/{id}',
  '/v1/customers/{customer_id}/addresses', '/v1/customers/{customer_id}/addresses/{address_id}',
  '/v1/chargebacks/{id}', '/oauth/token', '/v1/payment_methods/installments', '/v1/identification_types',
  '/preapproval/export', '/v1/advanced_payments', '/v1/advanced_payments/{advanced_payment_id}',
  '/v1/payments/{id}/cancellations', '/v1/payments/{id}/refunds/{refund_id}',
  // payground derives merchant orders from preferences, so they are read-only here.
  '/merchant_orders',
];

/** Our patterns use short parameter names; the spec spells them out. */
const normalise = (pattern: string): string =>
  pattern.replace(/:order_id|:customer_id/g, ':id').replace(/:transaction_id/g, ':tid');

const isEmulated = (path: string): boolean =>
  path.startsWith('/v1/payments') ||
  path.startsWith('/v1/orders') ||
  path.startsWith('/v1/card_tokens') ||
  path === '/v1/payment_methods' ||
  path.startsWith('/checkout/preferences') ||
  path.startsWith('/merchant_orders') ||
  path.startsWith('/preapproval') ||
  path.startsWith('/authorized_payments');

describe('route coverage', () => {
  const registered = new Set(Object.keys(app().routes));

  test('every registered pattern is a valid Bun path', () => {
    for (const pattern of registered) {
      expect(pattern.startsWith('/')).toBe(true);
      expect(pattern).not.toContain('{');
    }
  });

  test('the spec endpoints we claim to emulate are all wired', () => {
    const missing = ROUTES.filter((route) => isEmulated(route.path) && !UNIMPLEMENTED.includes(route.path))
      .filter((route) => !(route.path === '/merchant_orders/{id}' && route.method === 'PUT'))
      .map((route) => route.pattern)
      .filter((pattern) => !registered.has(normalise(pattern)));

    expect([...new Set(missing)]).toEqual([]);
  });

  test('the control namespace never overlaps the emulated one', () => {
    for (const pattern of registered) {
      const control = pattern.startsWith('/_payground');
      const emulated = ROUTES.some((route) => route.pattern === pattern);
      expect(control && emulated).toBe(false);
    }
  });
});

describe('method handling', () => {
  test('a known path with the wrong method is not a 200', async () => {
    const server = createServer({
      port: 0,
      storage: Storage.open(),
      deliveryIntervalMs: 0,
      bootstrap: { accessToken: 'TEST-a', publicKey: 'TEST-p', webhookSecret: 's' },
    });
    close = async () => {
      await server.stop(true);
    };

    for (const [method, path] of [
      ['DELETE', '/v1/payments'],
      ['PATCH', '/v1/payments/1'],
      ['POST', '/v1/payment_methods'],
    ] as const) {
      const response = await fetch(`${server.url.origin}${path}`, {
        method,
        headers: { authorization: 'Bearer TEST-a' },
      });
      expect([method, path, response.ok]).toEqual([method, path, false]);
      await response.text();
    }
  });
});
