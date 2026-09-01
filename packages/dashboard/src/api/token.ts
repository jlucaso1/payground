const KEY = 'payground.adminToken';

/** Kept in sessionStorage so the token dies with the tab rather than lingering on disk. */
export function readToken(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeToken(token: string | null): void {
  try {
    if (token === null || token === '') globalThis.sessionStorage?.removeItem(KEY);
    else globalThis.sessionStorage?.setItem(KEY, token);
  } catch {
    /* storage can be blocked; the dashboard still works for one request at a time */
  }
}
