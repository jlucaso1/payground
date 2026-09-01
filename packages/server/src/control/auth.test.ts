import { describe, expect, test } from 'bun:test';
import { requireAdmin } from './auth.ts';

const url = new URL('http://localhost/_payground/sandboxes');
const request = (headers: Record<string, string> = {}) => new Request(url.toString(), { headers });

describe('admin token', () => {
  test('an unset token leaves the control API open, for a bare local instance', () => {
    expect(requireAdmin(request(), url, null)).toBeNull();
    expect(requireAdmin(request(), url, '')).toBeNull();
  });

  test('a missing or wrong token is refused', () => {
    expect(requireAdmin(request(), url, 'secret')?.status).toBe(401);
    expect(requireAdmin(request({ authorization: 'Bearer nope' }), url, 'secret')?.status).toBe(401);
    expect(requireAdmin(request({ authorization: 'Basic secret' }), url, 'secret')?.status).toBe(401);
    expect(requireAdmin(request({ authorization: 'Bearer ' }), url, 'secret')?.status).toBe(401);
  });

  test('accepts the token as a bearer, a header or a query parameter', () => {
    expect(requireAdmin(request({ authorization: 'Bearer secret' }), url, 'secret')).toBeNull();
    expect(requireAdmin(request({ 'x-payground-admin-token': 'secret' }), url, 'secret')).toBeNull();

    const withQuery = new URL('http://localhost/_payground/sandboxes?admin_token=secret');
    expect(requireAdmin(new Request(withQuery.toString()), withQuery, 'secret')).toBeNull();
  });

  test('a token of a different length is refused without leaking the comparison', () => {
    expect(requireAdmin(request({ authorization: 'Bearer s' }), url, 'secret')?.status).toBe(401);
    expect(requireAdmin(request({ authorization: 'Bearer secretsecret' }), url, 'secret')?.status).toBe(401);
  });

  test('the denial never echoes the supplied token', () => {
    const denial = requireAdmin(request({ authorization: 'Bearer leak-me' }), url, 'secret');
    expect(JSON.stringify(denial)).not.toContain('leak-me');
  });
});
