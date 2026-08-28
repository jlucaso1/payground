import { useCallback, useEffect, useState } from 'react';
import type { ApiError, ApiResult } from '../api/client.ts';

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: ApiError }
  | { status: 'ready'; value: T };

export interface AsyncHandle<T> {
  state: AsyncState<T>;
  reload: () => void;
}

export function useAsync<T>(run: () => Promise<ApiResult<T>>, deps: readonly unknown[]): AsyncHandle<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);

  const runner = useCallback(run, deps);

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    void runner().then((result) => {
      if (!active) return;
      setState(result.ok ? { status: 'ready', value: result.value } : { status: 'error', error: result.error });
    });
    return () => {
      active = false;
    };
  }, [runner, nonce]);

  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  return { state, reload };
}
