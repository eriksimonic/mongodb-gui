import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  RPC_EVENT_CHANNEL,
  RPC_INVOKE_CHANNEL,
  appError,
  type RpcEvent,
  type RpcResult,
} from '@mongo-gui/core';
import { isAppUrl } from '../app-origin';
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
      if (!isTrustedSender(event, window)) {
        return {
          ok: false,
          error: appError('VALIDATION', 'The request came from an untrusted page.'),
        };
      }
      if (typeof method !== 'string') {
        return { ok: false, error: appError('VALIDATION', 'The method name must be a string.') };
      }
      return router.handle(method, input);
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
