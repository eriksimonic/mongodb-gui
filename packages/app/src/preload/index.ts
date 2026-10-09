import { contextBridge, ipcRenderer } from 'electron';
import type { MongoGuiApi } from '@mongo-gui/ui';

async function ping(): Promise<string> {
  const result: unknown = await ipcRenderer.invoke('app:ping');
  if (typeof result !== 'string') {
    throw new Error('app:ping returned a non-string value');
  }
  return result;
}

const api: MongoGuiApi = { ping };

contextBridge.exposeInMainWorld('mongoGui', api);
