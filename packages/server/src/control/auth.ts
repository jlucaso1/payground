import { timingSafeEqual } from 'node:crypto';

export interface AdminDenial {
  status: number;
  body: { error: string; message: string };
}

const deny = (message: string): AdminDenial => ({
  status: 401,
  body: { error: 'unauthorized', message },
});

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function present(request: Request, url: URL): string | null {
  const header = request.headers.get('authorization');
  if (header !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match?.[1]?.trim() ?? null;
  }
  const token = request.headers.get('x-payground-admin-token') ?? url.searchParams.get('admin_token');
  return token === null || token === '' ? null : token;
}

/**
 * The control API can create sandboxes, read every tenant's credentials and force any
 * payment to approved, so it is gated on a single admin token. Returns null when allowed.
 */
export function requireAdmin(request: Request, url: URL, expected: string | null): AdminDenial | null {
  if (expected === null || expected === '') return null;

  const supplied = present(request, url);
  if (supplied === null) return deny('an admin token is required for the control API');
  if (!equal(supplied, expected)) return deny('invalid admin token');
  return null;
}
