const KEY = 'payground.adminToken';

export interface Session {
  token: string | null;
  unauthorized: boolean;
  /** Bumped on every token change so screens remount and retry their requests. */
  nonce: number;
}

function load(): string | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(KEY) ?? null;
    return raw === '' ? null : raw;
  } catch {
    return null;
  }
}

function store(token: string | null): void {
  try {
    if (token === null) globalThis.sessionStorage?.removeItem(KEY);
    else globalThis.sessionStorage?.setItem(KEY, token);
  } catch {
    /* storage can be blocked; the token still lives in memory for this page */
  }
}

let session: Session = { token: load(), unauthorized: false, nonce: 0 };
const listeners = new Set<() => void>();

function emit(next: Session): void {
  session = next;
  for (const listener of [...listeners]) listener();
}

export function getSession(): Session {
  return session;
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Kept in sessionStorage so the token dies with the tab rather than lingering on disk. */
export function readToken(): string | null {
  return session.token;
}

export function writeToken(token: string | null): void {
  const value = token === null || token === '' ? null : token;
  store(value);
  emit({ token: value, unauthorized: false, nonce: session.nonce + 1 });
}

/** Ignored when the rejected request carried a token the user has already replaced. */
export function markUnauthorized(token: string | null): void {
  if (token !== session.token || session.unauthorized) return;
  emit({ token: session.token, unauthorized: true, nonce: session.nonce });
}

/** Test-only reset of the in-memory session. */
export function resetSession(): void {
  store(null);
  emit({ token: null, unauthorized: false, nonce: 0 });
}
