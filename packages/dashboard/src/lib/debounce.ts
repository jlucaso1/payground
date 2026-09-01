import { useEffect, useState } from 'react';

/** Keeps text filters out of the request path until typing settles. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return settled;
}
