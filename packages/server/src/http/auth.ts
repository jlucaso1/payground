import { type Result, type Sandbox, type SandboxRegistry, err, ok } from '@payground/core';
import { type ErrorBody, forbidden, unauthorized } from '@payground/mercadopago/errors.ts';

export type CredentialKind = 'access_token' | 'public_key';

export interface Principal {
  readonly sandbox: Sandbox;
  readonly credential: CredentialKind;
  readonly token: string;
}

const PREFIXES = ['TEST-', 'APP_USR-'];

function extract(request: Request, url: URL): { token: string; from: CredentialKind | null } | null {
  const header = request.headers.get('authorization');
  if (header !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1] !== undefined) return { token: match[1].trim(), from: null };
    return null;
  }
  const access = url.searchParams.get('access_token');
  if (access !== null) return { token: access, from: 'access_token' };
  const publicKey = url.searchParams.get('public_key');
  if (publicKey !== null) return { token: publicKey, from: 'public_key' };
  return null;
}

export function authenticate(
  registry: SandboxRegistry,
  request: Request,
  url: URL,
  accepts: readonly CredentialKind[] = ['access_token'],
): Result<Principal, ErrorBody> {
  const candidate = extract(request, url);
  if (candidate === null || candidate.token === '') return err(unauthorized('malformed access_token'));

  const { token } = candidate;
  if (!PREFIXES.some((prefix) => token.startsWith(prefix))) {
    return err(unauthorized('malformed access_token'));
  }

  const byAccess = registry.byAccessToken(token);
  if (byAccess !== null) {
    return accepts.includes('access_token')
      ? ok({ sandbox: byAccess, credential: 'access_token', token })
      : err(forbidden('this endpoint requires a public key'));
  }

  const byPublic = registry.byPublicKey(token);
  if (byPublic !== null) {
    return accepts.includes('public_key')
      ? ok({ sandbox: byPublic, credential: 'public_key', token })
      : err(unauthorized('invalid access token'));
  }

  return err(unauthorized('invalid access token'));
}
