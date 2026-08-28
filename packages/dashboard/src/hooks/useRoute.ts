import { useCallback, useEffect, useState } from 'react';
import { parseRoute, routeToHash, type Route } from '../lib/router.ts';

export function useRoute(): { route: Route; navigate: (next: Route) => void } {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onChange = (): void => {
      setRoute(parseRoute(window.location.hash));
    };
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, []);

  const navigate = useCallback((next: Route) => {
    window.location.hash = routeToHash(next);
  }, []);

  return { route, navigate };
}
