import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { PreloadBridge, RpcResult } from '@mongo-gui/core';
import { RPC_EVENT_CHANNEL, RPC_INVOKE_CHANNEL } from '@mongo-gui/core/channels';

// The only object the renderer can reach. It carries no ipcRenderer reference.
const bridge: PreloadBridge = {
  invoke(method: string, input: unknown): Promise<RpcResult> {
    return ipcRenderer.invoke(RPC_INVOKE_CHANNEL, method, input);
  },
  onEvent(listener: (event: unknown) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      listener(payload);
    };
    ipcRenderer.on(RPC_EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(RPC_EVENT_CHANNEL, handler);
    };
  },
};

contextBridge.exposeInMainWorld('mongoGui', bridge);
