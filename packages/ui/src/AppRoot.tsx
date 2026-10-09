import type { ReactNode } from 'react';
import { UiApiProvider, type UiApi } from './api/ui-api';
import { AppProviders } from './theme/AppProviders';
import type { AppData } from './state/app-store';
import { AppStoreProvider } from './state/AppStoreProvider';
import { ProfilerStoreProvider } from './profiler/ProfilerStoreProvider';

export interface AppRootProps {
  readonly api: UiApi;
  readonly initialState?: Partial<AppData> | undefined;
  readonly children: ReactNode;
}

/** Every provider the UI needs: theme, api, store. Used by the app, stories and tests. */
export function AppRoot({ api, initialState, children }: AppRootProps) {
  return (
    <AppProviders>
      <UiApiProvider api={api}>
        <AppStoreProvider initialState={initialState}>
          <ProfilerStoreProvider>{children}</ProfilerStoreProvider>
        </AppStoreProvider>
      </UiApiProvider>
    </AppProviders>
  );
}
