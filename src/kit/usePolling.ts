import { useEffect, useRef } from 'react';

/**
 * Polls an async callback on a fixed interval while mounted and tab is visible.
 */
export function usePolling(fn: () => void | Promise<void>, ms: number, enabled = true): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled || ms <= 0) return;

    let cancelled = false;
    const timer = setInterval(() => {
      if (!cancelled && document.visibilityState !== 'hidden') {
        void fnRef.current();
      }
    }, ms);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ms, enabled]);
}
