import { app, BrowserWindow, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// One source of truth for "dev": a packaged app never uses the dev server, even if the
// environment variable is set.
const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
const rendererDirectory = join(import.meta.dirname, '../renderer');
const preloadPath = join(import.meta.dirname, '../preload/index.cjs');

function contentSecurityPolicy(): string {
  if (devServerUrl === undefined) {
    return [
      "default-src 'self'",
      "script-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
  }
  const origin = new URL(devServerUrl).origin;
  const socketOrigin = origin.replace(/^http/, 'ws');
  // Development only: @vitejs/plugin-react injects an inline react-refresh preamble into
  // index.html, so scripts need 'unsafe-inline' here. Production keeps script-src 'self'.
  return [
    `default-src 'self' ${origin} ${socketOrigin}`,
    `script-src 'self' ${origin} 'unsafe-inline'`,
    `style-src 'self' ${origin} 'unsafe-inline'`,
    `connect-src 'self' ${origin} ${socketOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function installContentSecurityPolicy(): void {
  const policy = contentSecurityPolicy();
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders: Record<string, string[]> = {};
    for (const [name, values] of Object.entries(details.responseHeaders ?? {})) {
      if (name.toLowerCase() !== 'content-security-policy') {
        responseHeaders[name] = values;
      }
    }
    responseHeaders['Content-Security-Policy'] = [policy];
    callback({ responseHeaders });
  });
}

// Only the renderer pages this app ships may load in the window.
function isAppUrl(url: string): boolean {
  if (devServerUrl !== undefined) {
    return url.startsWith(`${new URL(devServerUrl).origin}/`);
  }
  return url.startsWith(`${pathToFileURL(rendererDirectory).href}/`);
}

function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const blockForeignNavigation = (event: Electron.Event, url: string): void => {
    if (!isAppUrl(url)) {
      event.preventDefault();
    }
  };
  window.webContents.on('will-navigate', blockForeignNavigation);
  window.webContents.on('will-redirect', blockForeignNavigation);
  window.webContents.on('will-frame-navigate', (details) => {
    if (!isAppUrl(details.url)) {
      details.preventDefault();
    }
  });

  if (devServerUrl !== undefined) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(rendererDirectory, 'index.html'));
  }
}

// Webviews are a second renderer surface with their own preload and node settings.
// Refuse them on every web contents.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
});

app.whenReady().then(() => {
  installContentSecurityPolicy();
  ipcMain.handle('app:ping', () => 'pong');
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
