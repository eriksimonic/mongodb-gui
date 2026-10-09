import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import type { AppState, AppStore } from './app-store';

export const AppStoreContext = createContext<AppStore | undefined>(undefined);

/** Reads a slice of the app store. Must be used below `AppStoreProvider`. */
export function useAppStore<T>(selector: (state: AppState) => T): T {
  const store = useContext(AppStoreContext);
  if (store === undefined) {
    throw new Error('useAppStore must be used inside AppStoreProvider');
  }
  return useStore(store, selector);
}
