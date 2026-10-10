import { useEffect, useState, type ReactNode } from 'react';
import { useUiApi } from '../api/ui-api';
import { createChangesStore } from './changes-store';
import { ChangesStoreContext } from './changes-store-context';

export interface ChangesStoreProviderProps {
  readonly children: ReactNode;
}

/** Creates the change stream store for the api in context and forwards change events to it. */
export function ChangesStoreProvider({ children }: ChangesStoreProviderProps) {
  const api = useUiApi();
  const [store] = useState(() => createChangesStore(api));

  useEffect(() => api.onEvent((event) => store.getState().applyEvent(event)), [api, store]);

  return <ChangesStoreContext.Provider value={store}>{children}</ChangesStoreContext.Provider>;
}
