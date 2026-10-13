import { useEffect } from 'react';

/**
 * Calls `tick` every `intervalMs` while `intervalMs` is a positive number. Pass undefined or 0 to
 * pause. The timer restarts when `tick` or `intervalMs` changes, so pass a stable callback.
 */
export function usePolling(tick: () => void, intervalMs: number | undefined): void {
  useEffect(() => {
    if (intervalMs === undefined || intervalMs <= 0) {
      return undefined;
    }
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }, [tick, intervalMs]);
}
