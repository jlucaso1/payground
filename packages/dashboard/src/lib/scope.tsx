import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/instance.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { inputClass } from '../components/ui.tsx';

const KEY = 'payground.scopeSandbox';

/** Sandbox scope shared by the metrics and history screens, which live outside the sandbox routes. */
export function readScope(): string | null {
  try {
    const value = globalThis.sessionStorage?.getItem(KEY) ?? null;
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

export function writeScope(id: string | null): void {
  try {
    if (id === null || id === '') globalThis.sessionStorage?.removeItem(KEY);
    else globalThis.sessionStorage?.setItem(KEY, id);
  } catch {
    /* storage can be blocked; the scope then lives for this screen only */
  }
}

export function useScope(): [string | null, (id: string | null) => void] {
  const [scope, setScope] = useState<string | null>(readScope);
  const update = useCallback((id: string | null) => {
    const next = id === null || id === '' ? null : id;
    writeScope(next);
    setScope(next);
  }, []);
  return [scope, update];
}

export function ScopeSelect({
  scope,
  onChange,
}: {
  scope: string | null;
  onChange: (id: string | null) => void;
}): ReactNode {
  const { state } = useAsync(() => api.listSandboxes(), []);
  const sandboxes = state.status === 'ready' ? state.value : [];
  const stale = state.status === 'ready' && scope !== null && !sandboxes.some((s) => s.id === scope);

  // A scope left over from a deleted sandbox would 404 every query; drop it.
  useEffect(() => {
    if (stale) onChange(null);
  }, [stale, onChange]);

  return (
    <select
      className={inputClass}
      aria-label="Sandbox scope"
      value={scope ?? ''}
      onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
    >
      <option value="">All sandboxes</option>
      {sandboxes.map((sandbox) => (
        <option key={sandbox.id} value={sandbox.id}>
          {sandbox.name} ({sandbox.id})
        </option>
      ))}
    </select>
  );
}
