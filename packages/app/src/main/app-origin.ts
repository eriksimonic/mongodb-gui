import { app } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// One source of truth for "dev": a packaged app never uses the dev server, even if the
// environment variable is set.
export const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
export const rendererDirectory = join(import.meta.dirname, '../renderer');

/** Only the renderer pages this app ships may load in the window or call the RPC bridge. */
export function isAppUrl(url: string): boolean {
  if (devServerUrl !== undefined) {
    return url.startsWith(`${new URL(devServerUrl).origin}/`);
  }
  return url.startsWith(`${pathToFileURL(rendererDirectory).href}/`);
}
