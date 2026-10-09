import { useEffect, useState, type ReactNode } from 'react';
import { useUiApi } from '../api/ui-api';
import { createProfilerStore } from './profiler-store';
import { ProfilerStoreContext } from './profiler-store-context';

export interface ProfilerStoreProviderProps {
  readonly children: ReactNode;
}

/** Creates the profiler store for the api in context and forwards profiler events to it. */
export function ProfilerStoreProvider({ children }: ProfilerStoreProviderProps) {
  const api = useUiApi();
  const [store] = useState(() => createProfilerStore(api));

  useEffect(() => api.onEvent((event) => store.getState().applyEvent(event)), [api, store]);

  return <ProfilerStoreContext.Provider value={store}>{children}</ProfilerStoreContext.Provider>;
}
