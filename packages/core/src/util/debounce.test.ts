import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce } from './debounce';

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once, after the wait, with the last arguments', () => {
    const action = vi.fn<(value: number) => void>();
    const delayed = debounce(action, 500);

    delayed.call(1);
    vi.advanceTimersByTime(300);
    delayed.call(2);
    vi.advanceTimersByTime(499);
    expect(action).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith(2);
  });

  it('flush runs the pending call now and only once', () => {
    const action = vi.fn<(value: string) => void>();
    const delayed = debounce(action, 500);

    delayed.call('a');
    delayed.flush();
    expect(action).toHaveBeenCalledWith('a');

    vi.advanceTimersByTime(1000);
    delayed.flush();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('cancel drops the pending call', () => {
    const action = vi.fn<() => void>();
    const delayed = debounce(action, 500);

    delayed.call();
    delayed.cancel();
    vi.advanceTimersByTime(1000);
    expect(action).not.toHaveBeenCalled();
  });
});
