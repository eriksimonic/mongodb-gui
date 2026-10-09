import { app, BrowserWindow, session } from 'electron';
import { join } from 'node:path';
import { devServerUrl, isAppUrl, rendererDirectory } from './app-origin';
import { log } from './log';
import { createAppServices, createRouter, type AppServices, type Router } from './rpc/router';
import { registerIpc, sendEvent } from './rpc/ipc';

const preloadPath = join(import.meta.dirname, '../preload/index.cjs');

// Tests point the profile at a temporary directory. A packaged app never honours this.
const userDataOverride = app.isPackaged ? undefined : process.env['MONGO_GUI_USER_DATA'];
if (userDataOverride !== undefined && userDataOverride !== '') {
  app.setPath('userData', userDataOverride);
}

let mainWindow: BrowserWindow | undefined;
let services: AppServices | undefined;
let router: Router | undefined;
let quitting = false;

function contentSecurityPolicy(): string {
  if (devServerUrl === undefined) {
    return [
      "default-src 'self'",
      "script-src 'self'",
      // Monaco runs its language and editor workers as blob: URLs.
      "worker-src 'self' blob:",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data:",
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
    "worker-src 'self' blob:",
    `style-src 'self' ${origin} 'unsafe-inline'`,
    `font-src 'self' ${origin} data:`,
    `img-src 'self' ${origin} data:`,
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
  mainWindow = window;
  if (router !== undefined) {
    registerIpc(router, window);
  }

  window.once('ready-to-show', () => {
    window.show();
  });

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
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

app
  .whenReady()
  .then(() => {
    installContentSecurityPolicy();
    const appServices = createAppServices({ userDataDir: app.getPath('userData') });
    services = appServices;
    router = createRouter({
      ...appServices,
      onEvent: (event) => {
        if (mainWindow !== undefined) {
          sendEvent(mainWindow, event);
        }
      },
    });
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  })
  .catch((error: unknown) => {
    log.error('startup failed', { error: error instanceof Error ? error.message : String(error) });
    app.exit(1);
  });

// Locking first disconnects every client and drops the key. Disposal then closes the store,
// and only after that does the quit go through.
app.on('before-quit', (event) => {
  if (quitting || services === undefined) {
    return;
  }
  event.preventDefault();
  quitting = true;
  const current = services;
  current.vault.lock();
  void current
    .dispose()
    .catch((error: unknown) => {
      log.error('dispose failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
