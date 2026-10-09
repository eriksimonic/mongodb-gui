import type { RpcClient, RpcEvent } from '@mongo-gui/core';
import { createContext, createElement, useContext, type ReactNode } from 'react';

/** Everything the UI needs from the backend: typed calls and pushed events. */
export interface UiApi {
  readonly rpc: RpcClient;
  onEvent(listener: (event: RpcEvent) => void): () => void;
}

const UiApiContext = createContext<UiApi | undefined>(undefined);

export interface UiApiProviderProps {
  readonly api: UiApi;
  readonly children: ReactNode;
}

export function UiApiProvider({ api, children }: UiApiProviderProps) {
  return createElement(UiApiContext.Provider, { value: api }, children);
}

export function useUiApi(): UiApi {
  const api = useContext(UiApiContext);
  if (api === undefined) {
    throw new Error('useUiApi must be used inside UiApiProvider');
  }
  return api;
}
