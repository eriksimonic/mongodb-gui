import { useEffect, type ReactNode } from 'react';
import { UiApiProvider, type UiApi } from './api/ui-api';
import { AppProviders } from './theme/AppProviders';
import { useResolvedColorScheme } from './theme/color-scheme';
import { applyFontScale } from './theme/font-scale';
import type { AppData } from './state/app-store';
import { AppStoreProvider } from './state/AppStoreProvider';
import { useAppStore } from './state/app-store-context';
import { ProfilerStoreProvider } from './profiler';
import { ChangesStoreProvider } from './changes/ChangesStoreProvider';

export interface AppRootProps {
  readonly api: UiApi;
  readonly initialState?: Partial<AppData> | undefined;
  readonly children: ReactNode;
}

/** Every provider the UI needs: api, store, theme. Used by the app, stories and tests. */
export function AppRoot({ api, initialState, children }: AppRootProps) {
  return (
    <UiApiProvider api={api}>
      <AppStoreProvider initialState={initialState}>
        <ThemedProviders>
          <ProfilerStoreProvider>
            <ChangesStoreProvider>{children}</ChangesStoreProvider>
          </ProfilerStoreProvider>
        </ThemedProviders>
      </AppStoreProvider>
    </UiApiProvider>
  );
}

/** Reads the theme and font size settings from the store, so a change in settings re-themes and rescales the whole app. */
function ThemedProviders({ children }: { readonly children: ReactNode }) {
  const setting = useAppStore((state) => state.theme);
  const colorScheme = useResolvedColorScheme(setting);
  const fontSize = useAppStore((state) => state.settings?.editorFontSize);
  useEffect(() => applyFontScale(fontSize), [fontSize]);
  return <AppProviders colorScheme={colorScheme}>{children}</AppProviders>;
}
