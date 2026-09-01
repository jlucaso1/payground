import { beforeEach, describe, expect, test } from 'bun:test';
import { createApiClient, type FetchLike, type SandboxDetail } from '../src/api/client.ts';
import {
  getSession,
  markUnauthorized,
  readToken,
  resetSession,
  subscribeSession,
  writeToken,
} from '../src/api/token.ts';
import type { Sandbox } from '../src/api/types.ts';

const SANDBOX: Sandbox = {
  id: 'sbx_1',
  name: 'demo',
  accessToken: 'TEST-token',
  publicKey: 'TEST-key',
  webhookSecret: 'whsec',
  liveMode: false,
  createdAt: 1_700_000_000_000,
};

const detail = (id: string, payments: number, webhooks: number): SandboxDetail => ({
  ...SANDBOX,
  id,
  counts: { payments, webhooks },
});

describe('session store', () => {
  beforeEach(() => {
    resetSession();
  });

  test('starts signed out', () => {
    expect(getSession()).toEqual({ token: null, unauthorized: false, nonce: 0 });
  });

  test('writing a token clears the unauthorized flag and bumps the nonce', () => {
    markUnauthorized(null);
    expect(getSession().unauthorized).toBe(true);

    writeToken('secret');
    expect(readToken()).toBe('secret');
    expect(getSession().unauthorized).toBe(false);
    expect(getSession().nonce).toBe(1);
  });

  test('re-entering the same token still bumps the nonce so screens retry', () => {
    writeToken('secret');
    writeToken('secret');
    expect(getSession().nonce).toBe(2);
  });

  test('an empty token is stored as null', () => {
    writeToken('');
    expect(readToken()).toBe(null);
  });

  test('signing out clears the token without prompting yet', () => {
    writeToken('secret');
    writeToken(null);
    expect(getSession()).toEqual({ token: null, unauthorized: false, nonce: 2 });
  });

  test('a 401 carrying a replaced token is ignored', () => {
    writeToken('fresh');
    markUnauthorized('stale');
    expect(getSession().unauthorized).toBe(false);
    markUnauthorized('fresh');
    expect(getSession().unauthorized).toBe(true);
  });

  test('marking unauthorized twice notifies once', () => {
    let notified = 0;
    const unsubscribe = subscribeSession(() => {
      notified += 1;
    });
    markUnauthorized(null);
    markUnauthorized(null);
    unsubscribe();
    markUnauthorized(null);
    expect(notified).toBe(1);
  });

  test('unsubscribing stops notifications', () => {
    let notified = 0;
    subscribeSession(() => {
      notified += 1;
    })();
    writeToken('secret');
    expect(notified).toBe(0);
  });
});

describe('onUnauthorized', () => {
  test('fires on a 401 with the token that was sent, and not on other failures', async () => {
    const seen: (string | null)[] = [];
    const client = (status: number, token: string | null) =>
      createApiClient({
        fetch: async () => new Response('nope', { status }),
        token: () => token,
        onUnauthorized: (sent) => seen.push(sent),
      });

    await client(401, 'secret').listSandboxes();
    await client(401, '').listSandboxes();
    await client(500, 'secret').listSandboxes();
    await client(404, 'secret').listSandboxes();
    expect(seen).toEqual(['secret', null]);
  });
});

describe('listSandboxDetails', () => {
  const route = (handler: (url: string) => Response): { fetch: FetchLike; urls: string[] } => {
    const urls: string[] = [];
    return {
      urls,
      fetch: async (url) => {
        urls.push(url);
        return handler(url);
      },
    };
  };

  test('fetches one detail per sandbox', async () => {
    const { fetch, urls } = route((url) =>
      url.endsWith('/sandboxes')
        ? Response.json([SANDBOX, { ...SANDBOX, id: 'sbx_2' }])
        : Response.json(detail(url.endsWith('sbx_2') ? 'sbx_2' : 'sbx_1', 3, 4)),
    );
    const result = await createApiClient({ fetch }).listSandboxDetails();
    expect(result.ok && result.value.map((s) => s.id)).toEqual(['sbx_1', 'sbx_2']);
    expect(result.ok && result.value[0]?.counts).toEqual({ payments: 3, webhooks: 4 });
    expect(urls).toEqual([
      '/_payground/sandboxes',
      '/_payground/sandboxes/sbx_1',
      '/_payground/sandboxes/sbx_2',
    ]);
  });

  test('keeps the sandbox with null counts when its detail fails', async () => {
    const { fetch } = route((url) =>
      url.endsWith('/sandboxes')
        ? Response.json([SANDBOX])
        : new Response('sandbox not found', { status: 404 }),
    );
    const result = await createApiClient({ fetch }).listSandboxDetails();
    expect(result.ok && result.value).toEqual([{ ...SANDBOX, counts: null }]);
  });

  test('propagates a 401 from the list', async () => {
    const { fetch } = route(() => new Response('', { status: 401 }));
    const result = await createApiClient({ fetch }).listSandboxDetails();
    expect(result.ok ? null : result.error.kind).toBe('unauthorized');
  });

  test('propagates a 401 from a detail instead of degrading it', async () => {
    const { fetch } = route((url) =>
      url.endsWith('/sandboxes') ? Response.json([SANDBOX]) : new Response('', { status: 401 }),
    );
    const result = await createApiClient({ fetch }).listSandboxDetails();
    expect(result.ok ? null : result.error.kind).toBe('unauthorized');
  });
});
