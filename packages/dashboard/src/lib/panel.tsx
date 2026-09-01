import type { ReactNode } from 'react';
import { isUnavailable } from '../api/client-observability.ts';
import { ErrorBox, Loading } from '../components/ui.tsx';
import type { AsyncState } from '../hooks/useAsync.ts';

/**
 * Renders an async panel. `what` names a collection endpoint, whose 404 means the instance does
 * not expose it; without `what` a 404 is a plain error, since it is about one missing resource.
 */
export function Panel<T>({
  state,
  what,
  children,
}: {
  state: AsyncState<T>;
  what?: string;
  children: (value: T) => ReactNode;
}): ReactNode {
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') {
    return what !== undefined && isUnavailable(state.error) ? (
      <p className="text-sm text-neutral-600">{what}: not available on this instance.</p>
    ) : (
      <ErrorBox error={state.error} />
    );
  }
  return children(state.value);
}
