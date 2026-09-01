import { useSyncExternalStore } from 'react';
import { getSession, subscribeSession, type Session } from '../api/token.ts';

export function useSession(): Session {
  return useSyncExternalStore(subscribeSession, getSession, getSession);
}
