import type { Settings } from '@mongo-gui/core';
import { useEffect, useState } from 'react';

/** The theme setting the user picks. `system` follows the operating system. */
export type ThemeSetting = Settings['theme'];

/** The scheme the page renders in. Mantine and the CSS tokens both read it. */
export type ColorScheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Turns the saved setting into the scheme to render. Only `system` depends on the operating system.
 * The dark scheme is the default when the system does not say.
 */
export function resolveColorScheme(setting: ThemeSetting, prefersDark: boolean): ColorScheme {
  if (setting === 'system') {
    return prefersDark ? 'dark' : 'light';
  }
  return setting;
}

/** The operating system's dark preference. True when the environment has no media query support. */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true;
  }
  return window.matchMedia(DARK_QUERY).matches;
}

/**
 * The scheme for a setting. With `system`, the result follows the media query live: a change of
 * the operating setting re-renders the app without a reload.
 */
export function useResolvedColorScheme(setting: ThemeSetting): ColorScheme {
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const query = window.matchMedia(DARK_QUERY);
    setPrefersDark(query.matches);
    const onChange = (event: MediaQueryListEvent): void => {
      setPrefersDark(event.matches);
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, []);
  return resolveColorScheme(setting, prefersDark);
}
