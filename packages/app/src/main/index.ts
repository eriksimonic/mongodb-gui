import {
  app,
  BrowserWindow,
  dialog,
  session,
  shell,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { join } from 'node:path';
import { devServerUrl, isAppUrl, rendererDirectory } from './app-origin';
import { log } from './log';
import {
  createAppServices,
  createRouter,
  type AppServices,
  type NativeDialogs,
  type Router,
} from './rpc/router';
import { registerIpc, sendEvent } from './rpc/ipc';
import { utilityFork } from './shell/utility-fork';

const preloadPath = join(import.meta.dirname, '../preload/index.cjs');
// Built next to this file by the build:shell-runtime script.
const shellRuntimePath = join(import.meta.dirname, 'shell-runtime.cjs');

// Tests point the profile at a temporary directory. A packaged app never honours this.
const userDataOverride = app.isPackaged ? undefined : process.env['MONGO_GUI_USER_DATA'];
if (userDataOverride !== undefined && userDataOverride !== '') {
  app.setPath('userData', userDataOverride);
}

let mainWindow: BrowserWindow | undefined;
let services: AppServices | undefined;
let router: Router | undefined;
let quitting = false;

/**
 * The file dialogs open over the main window. The renderer gets only the path the user picked.
 * A cancelled dialog gives no path.
 */
const nativeDialogs: NativeDialogs = {
  async showOpenDialog(input) {
    const options: OpenDialogOptions = {
      title: input.title,
      properties: ['openFile'],
      filters: input.filters.map((filter) => ({
        name: filter.name,
        extensions: filter.extensions,
      })),
    };
    const owner = mainWindow;
    const result =
      owner === undefined
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(owner, options);
    const first = result.filePaths[0];
    return result.canceled || first === undefined ? {} : { path: first };
  },
  async showSaveDialog(input) {
    const options: SaveDialogOptions = {
      title: input.title,
      filters: input.filters.map((filter) => ({
        name: filter.name,
        extensions: filter.extensions,
      })),
      ...(input.defaultPath === undefined ? {} : { defaultPath: input.defaultPath }),
    };
    const owner = mainWindow;
    const result =
      owner === undefined
        ? await dialog.showSaveDialog(options)
        : await dialog.showSaveDialog(owner, options);
    return result.canceled || result.filePath === '' ? {} : { path: result.filePath };
  },
  showItemInFolder(path) {
    shell.showItemInFolder(path);
  },
};

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
      shell: { entryPath: shellRuntimePath, fork: utilityFork },
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
      dialogs: nativeDialogs,
    });
    // Forwarders left behind by a crash or a force quit are removed before the user can connect.
    void appServices.docker.cleanupAll();
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
  // Quitting ends the transfers that the window started, as a reset of the renderer does.
  router?.resetRenderer();
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
