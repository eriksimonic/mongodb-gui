/** The two timer functions. Read from globalThis at call time, so fake timers in tests apply. */
interface TimerHost {
  setTimeout(action: () => void, waitMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const timers = globalThis as unknown as TimerHost;

export interface Debounced<A extends readonly unknown[]> {
  /** Schedules the call. A call made while one is pending replaces its arguments. */
  call(...args: A): void;
  /** Runs the pending call now, if there is one. */
  flush(): void;
  /** Drops the pending call without running it. */
  cancel(): void;
}

/**
 * Delays a function until no call has arrived for `waitMs`. Only the last arguments are used.
 * Timers come from the global scheduler, so fake timers in tests control them.
 */
export function debounce<A extends readonly unknown[]>(
  action: (...args: A) => void,
  waitMs: number,
): Debounced<A> {
  let timer: unknown;
  let pending: A | undefined;

  const cancel = (): void => {
    if (timer !== undefined) {
      timers.clearTimeout(timer);
      timer = undefined;
    }
    pending = undefined;
  };

  const flush = (): void => {
    const args = pending;
    cancel();
    if (args !== undefined) {
      action(...args);
    }
  };

  return {
    call(...args: A) {
      pending = args;
      if (timer !== undefined) {
        timers.clearTimeout(timer);
      }
      timer = timers.setTimeout(flush, waitMs);
    },
    flush,
    cancel,
  };
}
