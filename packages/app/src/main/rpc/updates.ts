import { appError, AppErrorException, rpcContract, type UpdateState } from '@mongo-gui/core';
import type { SettingsRepository } from '@mongo-gui/storage';
import { log } from '../log';
import {
  createUpdater,
  noopUpdaterBackend,
  type Updater,
  type UpdaterBackend,
} from '../updates/updater';
import { entry, type Operation } from './operation';

/** What the updater needs from Electron. Omitted in tests, where the updater stays inert. */
export interface UpdaterRuntime {
  readonly autoUpdater: UpdaterBackend;
  readonly platform: string;
  readonly isPackaged: boolean;
  readonly appVersion: string;
}

/** The updater plus a subscription for its state changes. Same shape as the router's UpdatesService. */
export type UpdatesHandle = Updater & {
  subscribe(listener: (state: UpdateState) => void): () => void;
};

type UpdatesCalls = Pick<Updater, 'state' | 'check' | 'download' | 'install' | 'dismiss'>;

export interface UpdatesDeps {
  readonly updates: UpdatesCalls | undefined;
}

export function updatesOperations(deps: UpdatesDeps): [string, Operation][] {
  const updatesService = (): UpdatesCalls => {
    if (deps.updates === undefined) {
      throw new AppErrorException(appError('INTERNAL', 'Updates are not available.'));
    }
    return deps.updates;
  };

  return [
    entry('updates.state', rpcContract.updates.state, () => updatesService().state()),
    entry('updates.check', rpcContract.updates.check, () => updatesService().check()),
    entry('updates.download', rpcContract.updates.download, () => updatesService().download()),
    entry('updates.install', rpcContract.updates.install, () => {
      updatesService().install();
    }),
    entry('updates.dismiss', rpcContract.updates.dismiss, (input) =>
      updatesService().dismiss(input.version),
    ),
  ];
}

/**
 * Builds the updater. The saved setting is encrypted, so it reads as undefined while the
 * vault is locked, and the updater waits for the next refreshSchedule call.
 */
export function createUpdatesService(
  runtime: UpdaterRuntime | undefined,
  currentHandles: () => { readonly repos: { readonly settings: Pick<SettingsRepository, 'get'> } },
): UpdatesHandle {
  const listeners = new Set<(state: UpdateState) => void>();
  const updater = createUpdater({
    log,
    settings: {
      readCheckForUpdates: () => {
        try {
          return currentHandles().repos.settings.get().checkForUpdates;
        } catch {
          return undefined;
        }
      },
    },
    onState: (state) => {
      for (const listener of [...listeners]) {
        listener(state);
      }
    },
    autoUpdater: runtime?.autoUpdater ?? noopUpdaterBackend,
    platform: runtime?.platform ?? process.platform,
    isPackaged: runtime?.isPackaged ?? false,
    appVersion: runtime?.appVersion ?? '0.0.0',
  });
  return {
    ...updater,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
