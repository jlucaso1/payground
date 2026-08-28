import { err, ok, type Result } from '@payground/core';
import { isBlockedAddress, isIpLiteral } from './address.ts';
import { encodeRequest, isValidMethod, ResponseParser } from './http.ts';

export { isBlockedAddress } from './address.ts';

export interface SafeRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
}

export interface SafeResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
  /** The IP actually connected to, for the delivery log. */
  address: string;
}

export type SafeFetchError =
  | { kind: 'invalid_url'; url: string }
  | { kind: 'unsupported_scheme'; scheme: string }
  | { kind: 'dns_failure'; hostname: string; message: string }
  | { kind: 'blocked_address'; hostname: string; address: string; reason: string }
  | { kind: 'timeout'; timeoutMs: number }
  | { kind: 'connection_failed'; message: string }
  | { kind: 'malformed_response'; message: string }
  | { kind: 'response_too_large'; limit: number };

export interface SafeFetchPolicy {
  /** Self-host escape hatch. Default false. */
  allowPrivateAddresses?: boolean;
  /** Hostnames always permitted even when private, e.g. ['localhost']. */
  allowlist?: readonly string[];
  /** Default 1 MiB. */
  maxResponseBytes?: number;
  /** Injected for tests. Defaults to node:dns lookup returning all records. */
  resolve?: (hostname: string) => Promise<readonly string[]>;
  /** Injected for tests. Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

async function defaultResolve(hostname: string): Promise<readonly string[]> {
  const dns = await import('node:dns');
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : String(cause);

export async function safeFetch(
  request: SafeRequest,
  policy: SafeFetchPolicy = {},
): Promise<Result<SafeResponse, SafeFetchError>> {
  const now = policy.now ?? Date.now;
  const start = now();
  const maxResponseBytes = policy.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return err({ kind: 'invalid_url', url: request.url });
  }

  const scheme = url.protocol.replace(/:$/, '');
  if (scheme !== 'http' && scheme !== 'https') return err({ kind: 'unsupported_scheme', scheme });

  // The request line and Host header are built by hand; a non-token method would splice the request.
  if (!isValidMethod(request.method) || url.hostname === '') return err({ kind: 'invalid_url', url: request.url });

  const secure = scheme === 'https';
  const port = url.port === '' ? (secure ? 443 : 80) : Number(url.port);
  const bracketed = url.hostname.startsWith('[') && url.hostname.endsWith(']');
  const hostname = bracketed ? url.hostname.slice(1, -1) : url.hostname;

  const allowlisted = (policy.allowlist ?? []).some((entry) => entry.toLowerCase() === hostname.toLowerCase());
  const skipValidation = allowlisted || policy.allowPrivateAddresses === true;

  let addresses: readonly string[];
  if (isIpLiteral(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await (policy.resolve ?? defaultResolve)(hostname);
    } catch (cause) {
      return err({ kind: 'dns_failure', hostname, message: message(cause) });
    }
    if (addresses.length === 0) return err({ kind: 'dns_failure', hostname, message: 'no address records' });
  }

  if (!skipValidation) {
    // Every record must pass: a rebinding server can return one public and one private address.
    for (const address of addresses) {
      const verdict = isBlockedAddress(address);
      if (verdict.blocked) return err({ kind: 'blocked_address', hostname, address, reason: verdict.reason });
    }
  }

  const address = addresses[0] as string;
  const hostHeader = `${bracketed ? `[${hostname}]` : hostname}${
    (secure && port === 443) || (!secure && port === 80) ? '' : `:${port}`
  }`;
  const payload = encodeRequest({
    method: request.method,
    target: `${url.pathname === '' ? '/' : url.pathname}${url.search}`,
    hostHeader,
    headers: request.headers,
    body: request.body,
  });

  const result = await transact({
    address,
    port,
    secure,
    serverName: hostname,
    payload,
    method: request.method,
    timeoutMs: request.timeoutMs,
    maxResponseBytes,
  });
  if (!result.ok) return result;
  return ok({ ...result.value, durationMs: now() - start, address });
}

interface TransactInput {
  address: string;
  port: number;
  secure: boolean;
  serverName: string;
  payload: Uint8Array;
  method: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

type PartialResponse = Omit<SafeResponse, 'durationMs' | 'address'>;

function transact(input: TransactInput): Promise<Result<PartialResponse, SafeFetchError>> {
  return new Promise((resolve) => {
    const parser = new ResponseParser(input.maxResponseBytes, input.method);
    let socket: { terminate: () => void } | null = null;
    let settled = false;

    const settle = (result: Result<PartialResponse, SafeFetchError>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.terminate();
      } catch {
        // socket already gone
      }
      resolve(result);
    };
    const timer = setTimeout(() => settle(err({ kind: 'timeout', timeoutMs: input.timeoutMs })), input.timeoutMs);
    const fail = (cause: unknown): void => settle(err({ kind: 'connection_failed', message: message(cause) }));

    // Connect to the validated IP, not the hostname: re-resolution here would reopen the TOCTOU window.
    Bun.connect({
      hostname: input.address,
      port: input.port,
      ...(input.secure ? { tls: { serverName: input.serverName } } : {}),
      socket: {
        open(sock) {
          socket = sock;
          sock.write(input.payload);
        },
        data(_sock, chunk) {
          const pushed = parser.push(chunk);
          if (!pushed.ok) settle(pushed);
          else if (pushed.value) settle(ok(parser.result()));
        },
        close() {
          settle(parser.finish());
        },
        error(_sock, cause) {
          fail(cause);
        },
        connectError(_sock, cause) {
          fail(cause);
        },
      },
    }).then(
      (sock) => {
        socket = sock;
        if (settled) sock.terminate();
      },
      (cause) => fail(cause),
    );
  });
}
