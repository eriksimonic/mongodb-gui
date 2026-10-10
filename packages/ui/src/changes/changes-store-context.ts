import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import type { ChangesStore, ChangesStoreState } from './changes-store';

export const ChangesStoreContext = createContext<ChangesStore | undefined>(undefined);

/** Reads a slice of the change stream store. Must be used below `ChangesStoreProvider`. */
export function useChangesStore<T>(selector: (state: ChangesStoreState) => T): T {
  const store = useContext(ChangesStoreContext);
  if (store === undefined) {
    throw new Error('useChangesStore must be used inside ChangesStoreProvider');
  }
  return useStore(store, selector);
}
