import { useEffect, useState, type ReactNode } from 'react';
import { useUiApi } from '../api/ui-api';
import { bridgeProfilerExplain } from '../explain/profiler-explain-bridge';
import { createAppStore, type AppData } from './app-store';
import { AppStoreContext } from './app-store-context';

export interface AppStoreProviderProps {
  /** Seeds the store once, when the provider mounts. Used by stories and tests. */
  readonly initialState?: Partial<AppData> | undefined;
  readonly children: ReactNode;
}

/** Creates the app store for the api in context, forwards backend events and reads the vault. */
export function AppStoreProvider({ initialState, children }: AppStoreProviderProps) {
  const api = useUiApi();
  const [store] = useState(() => createAppStore(api, initialState));

  useEffect(() => api.onEvent((event) => store.getState().applyEvent(event)), [api, store]);

  // The profiler's "Explain this" opens an explain panel in this store.
  useEffect(() => bridgeProfilerExplain(store), [store]);

  useEffect(() => {
    void store.getState().refreshVault();
    // A failed read leaves the updater state at its default, which shows nothing.
    store
      .getState()
      .refreshUpdates()
      .catch(() => undefined);
  }, [store]);

  return <AppStoreContext.Provider value={store}>{children}</AppStoreContext.Provider>;
}
