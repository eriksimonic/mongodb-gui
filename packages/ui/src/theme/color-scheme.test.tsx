// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveColorScheme, systemPrefersDark, useResolvedColorScheme } from './color-scheme';

interface FakeQuery {
  matches: boolean;
  listeners: Set<(event: MediaQueryListEvent) => void>;
}

/** Installs a matchMedia that reports one dark preference and lets a test change it. */
function installMatchMedia(initialDark: boolean): {
  set(dark: boolean): void;
  listenerCount(): number;
} {
  const query: FakeQuery = { matches: initialDark, listeners: new Set() };
  vi.stubGlobal('matchMedia', (media: string) => ({
    media,
    get matches() {
      return query.matches;
    },
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      query.listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      query.listeners.delete(listener);
    },
  }));
  return {
    set(dark: boolean) {
      query.matches = dark;
      for (const listener of query.listeners) {
        listener({ matches: dark } as MediaQueryListEvent);
      }
    },
    listenerCount: () => query.listeners.size,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveColorScheme', () => {
  it('uses the chosen scheme when the setting is dark or light', () => {
    expect(resolveColorScheme('dark', false)).toBe('dark');
    expect(resolveColorScheme('light', true)).toBe('light');
  });

  it('follows the operating system when the setting is system', () => {
    expect(resolveColorScheme('system', true)).toBe('dark');
    expect(resolveColorScheme('system', false)).toBe('light');
  });
});

describe('systemPrefersDark', () => {
  it('reads the dark preference from the media query', () => {
    installMatchMedia(false);
    expect(systemPrefersDark()).toBe(false);
  });

  it('defaults to dark when the environment has no media query support', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(systemPrefersDark()).toBe(true);
  });
});

describe('useResolvedColorScheme', () => {
  it('follows the system live when the setting is system', () => {
    const media = installMatchMedia(true);
    const { result } = renderHook(() => useResolvedColorScheme('system'));
    expect(result.current).toBe('dark');

    act(() => {
      media.set(false);
    });
    expect(result.current).toBe('light');
  });

  it('ignores the system preference when the setting is fixed', () => {
    const media = installMatchMedia(true);
    const { result } = renderHook(() => useResolvedColorScheme('light'));
    act(() => {
      media.set(true);
    });
    expect(result.current).toBe('light');
  });

  it('removes its listener on unmount', () => {
    const media = installMatchMedia(true);
    const { unmount } = renderHook(() => useResolvedColorScheme('system'));
    expect(media.listenerCount()).toBe(1);
    unmount();
    expect(media.listenerCount()).toBe(0);
  });
});
