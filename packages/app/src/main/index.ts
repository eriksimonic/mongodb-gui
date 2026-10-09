import { app, BrowserWindow, screen, session, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { join } from 'node:path';
import { devServerUrl, isAppUrl, rendererDirectory } from './app-origin';
import { log } from './log';
import {
  WINDOW_BOUNDS_KEY,
  clampBounds,
  debounce,
  parseWindowBounds,
  type WindowBounds,
} from '@mongo-gui/core';
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

const BOUNDS_SAVE_DELAY_MS = 500;

/**
 * Writes the window bounds under window:main. The vault must be unlocked, so a write while
 * locked is skipped and the next move or resize tries again.
 */
function writeWindowBounds(): void {
  const window = mainWindow;
  if (window === undefined || window.isDestroyed() || services === undefined) {
    return;
  }
  const { x, y, width, height } = window.getNormalBounds();
  const bounds: WindowBounds = { x, y, width, height, maximized: window.isMaximized() };
  try {
    services.currentRepos().layout.set(WINDOW_BOUNDS_KEY, bounds);
  } catch {
    // Locked vault. Nothing is saved until the next unlock and move.
  }
}

const boundsSaver = debounce(writeWindowBounds, BOUNDS_SAVE_DELAY_MS);

/**
 * Applies the saved bounds to the main window. Runs on window creation when the vault is open,
 * and after every unlock. A locked vault, or a window without saved bounds, keeps the defaults.
 */
function restoreWindowBounds(): void {
  const window = mainWindow;
  if (window === undefined || window.isDestroyed() || services === undefined) {
    return;
  }
  let stored: unknown;
  try {
    stored = services.currentRepos().layout.get(WINDOW_BOUNDS_KEY);
  } catch {
    return;
  }
  const saved = parseWindowBounds(stored);
  if (saved === undefined) {
    return;
  }
  // The display that holds most of the saved window, or the nearest one when none holds it.
  const display = screen.getDisplayMatching(saved);
  const fitted = clampBounds(saved, display.workArea);
  window.setBounds({ x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height });
  if (fitted.maximized) {
    window.maximize();
  }
}

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
    minWidth: 1024,
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

  // Bounds are read from the encrypted store, so they apply once the vault is open. The restore
  // after unlock covers the usual case, where the window opens at the locked screen first.
  restoreWindowBounds();
  window.on('move', () => {
    boundsSaver.call();
  });
  window.on('resize', () => {
    boundsSaver.call();
  });
  window.on('close', () => {
    boundsSaver.flush();
  });

  // The first update check runs ten seconds after the page loads and never blocks startup.
  // The check is armed here rather than on ready-to-show, which did not fire in testing.
  window.webContents.once('did-finish-load', () => {
    services?.updates.start();
  });

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
    router?.resetRenderer();
  });

  // A reload or a new page drops what the old page subscribed to. Same-document navigations keep
  // the page, so they do not reset.
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      router?.resetRenderer();
    }
  });
  window.webContents.on('render-process-gone', () => {
    router?.resetRenderer();
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
    const appServices = createAppServices({
      userDataDir: app.getPath('userData'),
      updates: {
        autoUpdater,
        platform: process.platform,
        isPackaged: app.isPackaged,
        appVersion: app.getVersion(),
      },
    });
    services = appServices;
    router = createRouter({
      ...appServices,
      onEvent: (event) => {
        if (mainWindow !== undefined) {
          sendEvent(mainWindow, event);
        }
      },
      openExternal: (url) => shell.openExternal(url),
      versions: () => ({
        app: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      }),
    });
    // Forwarders left behind by a crash or a force quit are removed before the user can connect.
    void appServices.docker.cleanupAll();
    appServices.unlockEvents.subscribe(() => {
      restoreWindowBounds();
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
  // The bounds are written while the vault is still open, so the last move is not lost.
  boundsSaver.flush();
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
