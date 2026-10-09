import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  RPC_EVENT_CHANNEL,
  RPC_INVOKE_CHANNEL,
  appError,
  toAppError,
  type RpcEvent,
  type RpcResult,
} from '@mongo-gui/core';
import { isAppUrl } from '../app-origin';
import { log } from '../log';
import type { Router } from './router';

/**
 * Routes renderer invocations to the router. Calls from any frame other than the window's
 * main frame, or from a page outside the app, are refused before they reach the router.
 */
export function registerIpc(router: Router, window: BrowserWindow): void {
  ipcMain.removeHandler(RPC_INVOKE_CHANNEL);
  ipcMain.handle(
    RPC_INVOKE_CHANNEL,
    async (event: IpcMainInvokeEvent, method: unknown, input: unknown): Promise<RpcResult> => {
      try {
        if (!isTrustedSender(event, window)) {
          return {
            ok: false,
            error: appError('VALIDATION', 'The request came from an untrusted page.'),
          };
        }
        if (typeof method !== 'string') {
          return { ok: false, error: appError('VALIDATION', 'The method name must be a string.') };
        }
        return await router.handle(method, input);
      } catch (error) {
        // The router never throws, so this path means a bug in the checks above. The renderer
        // still gets an answer, and the cause goes to the log.
        log.error('ipc handler failed', { error: toAppError(error).message });
        return { ok: false, error: appError('INTERNAL', 'Unexpected error') };
      }
    },
  );
}

/** Pushes an event to the window. Does nothing once the window or its contents are gone. */
export function sendEvent(window: BrowserWindow, event: RpcEvent): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    return;
  }
  window.webContents.send(RPC_EVENT_CHANNEL, event);
}

function isTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow): boolean {
  const frame = event.senderFrame;
  if (window.isDestroyed() || frame === null || frame !== window.webContents.mainFrame) {
    return false;
  }
  return isAppUrl(frame.url);
}
