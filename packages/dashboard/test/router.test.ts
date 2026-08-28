import { describe, expect, test } from 'bun:test';
import { parseRoute, routeSandboxId, routeToHash, type Route } from '../src/lib/router.ts';

describe('parseRoute', () => {
  const cases: [string, Route][] = [
    ['', { name: 'sandboxes' }],
    ['#', { name: 'sandboxes' }],
    ['#/', { name: 'sandboxes' }],
    ['#/sandboxes', { name: 'sandboxes' }],
    ['#/s/abc/payments', { name: 'payments', sandboxId: 'abc' }],
    ['#/s/abc/payments/pay_1', { name: 'payment', sandboxId: 'abc', paymentId: 'pay_1' }],
    ['#/s/abc/webhooks', { name: 'webhooks', sandboxId: 'abc' }],
    ['#/s/abc/faults', { name: 'faults', sandboxId: 'abc' }],
    ['#/s/a%20b/payments', { name: 'payments', sandboxId: 'a b' }],
    ['#/s/abc/payments?limit=5', { name: 'payments', sandboxId: 'abc' }],
    ['#/nope', { name: 'notFound', hash: '/nope' }],
    ['#/s/abc', { name: 'notFound', hash: '/s/abc' }],
    ['#/s/abc/payments/a/b', { name: 'notFound', hash: '/s/abc/payments/a/b' }],
    ['#/sandboxes/extra', { name: 'notFound', hash: '/sandboxes/extra' }],
  ];

  for (const [hash, expected] of cases) {
    test(`"${hash}"`, () => {
      expect(parseRoute(hash)).toEqual(expected);
    });
  }
});

describe('routeToHash', () => {
  test('round-trips every named route', () => {
    const routes: Route[] = [
      { name: 'sandboxes' },
      { name: 'payments', sandboxId: 'a b' },
      { name: 'payment', sandboxId: 'sbx', paymentId: 'pay/1' },
      { name: 'webhooks', sandboxId: 'sbx' },
      { name: 'faults', sandboxId: 'sbx' },
    ];
    for (const route of routes) {
      expect(parseRoute(routeToHash(route))).toEqual(route);
    }
  });
});

test('routeSandboxId', () => {
  expect(routeSandboxId({ name: 'sandboxes' })).toBe(null);
  expect(routeSandboxId({ name: 'notFound', hash: '/x' })).toBe(null);
  expect(routeSandboxId({ name: 'faults', sandboxId: 'sbx' })).toBe('sbx');
  expect(routeSandboxId({ name: 'payment', sandboxId: 'sbx', paymentId: 'p' })).toBe('sbx');
});
