import {
  createEventSource,
  createRpcClient,
  type PreloadBridge,
  type RpcClient,
  type RpcEvent,
} from '@mongo-gui/core';

export interface ElectronUiApi {
  readonly rpc: RpcClient;
  onEvent(listener: (event: RpcEvent) => void): () => void;
}

/** Builds the RPC client and event source over window.mongoGui, the preload bridge. */
export function createElectronUiApi(): ElectronUiApi {
  const bridge = readBridge();
  return {
    rpc: createRpcClient(bridge),
    onEvent: createEventSource(bridge),
  };
}

function readBridge(): PreloadBridge {
  const candidate: unknown = Reflect.get(window, 'mongoGui');
  if (!isPreloadBridge(candidate)) {
    throw new Error('window.mongoGui is missing. The preload script did not load.');
  }
  return candidate;
}

function isPreloadBridge(value: unknown): value is PreloadBridge {
  return (
    typeof value === 'object' &&
    value !== null &&
    'invoke' in value &&
    typeof value.invoke === 'function' &&
    'onEvent' in value &&
    typeof value.onEvent === 'function'
  );
}
