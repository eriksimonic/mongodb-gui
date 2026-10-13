// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePolling } from './use-polling';

describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls tick once per interval', () => {
    const tick = vi.fn();
    renderHook(() => usePolling(tick, 1000));

    expect(tick).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, 0, -5])('does not poll when interval is %s', (intervalMs) => {
    const tick = vi.fn();
    renderHook(() => usePolling(tick, intervalMs));

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(tick).not.toHaveBeenCalled();
  });

  it('stops when the interval becomes undefined', () => {
    const tick = vi.fn();
    const { rerender } = renderHook(({ intervalMs }) => usePolling(tick, intervalMs), {
      initialProps: { intervalMs: 1000 as number | undefined },
    });

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(tick).toHaveBeenCalledTimes(1);

    rerender({ intervalMs: undefined });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('restarts the timer when the interval changes', () => {
    const tick = vi.fn();
    const { rerender } = renderHook(({ intervalMs }) => usePolling(tick, intervalMs), {
      initialProps: { intervalMs: 1000 },
    });

    act(() => {
      vi.advanceTimersByTime(900);
    });
    rerender({ intervalMs: 500 });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('clears the timer on unmount', () => {
    const tick = vi.fn();
    const { unmount } = renderHook(() => usePolling(tick, 1000));

    unmount();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(tick).not.toHaveBeenCalled();
  });
});
