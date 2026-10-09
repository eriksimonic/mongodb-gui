import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import type { ProfilerStore, ProfilerStoreState } from './profiler-store';

export const ProfilerStoreContext = createContext<ProfilerStore | undefined>(undefined);

/** Reads a slice of the profiler store. Must be used below `ProfilerStoreProvider`. */
export function useProfilerStore<T>(selector: (state: ProfilerStoreState) => T): T {
  const store = useContext(ProfilerStoreContext);
  if (store === undefined) {
    throw new Error('useProfilerStore must be used inside ProfilerStoreProvider');
  }
  return useStore(store, selector);
}
