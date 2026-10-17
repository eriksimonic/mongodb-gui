import { appError, AppErrorException, rpcContract, toAppError, type RpcEvent } from '@mongo-gui/core';
import type { ConnectionManager } from '@mongo-gui/mongo-adapter';
import type { SettingsRepository, Vault } from '@mongo-gui/storage';
import type { DockerRuntime } from '../docker/runtime';
import type { Logger } from '../log';
import type { Updater } from '../updates/updater';
import { entry, type Operation } from './operation';

const MS_PER_MINUTE = 60_000;

export interface VaultDeps {
  readonly vault: Vault;
  readonly connections: Pick<ConnectionManager, 'disconnectAll'>;
  readonly docker: DockerRuntime | undefined;
  readonly updates: Pick<Updater, 'refreshSchedule'> | undefined;
  readonly repos: () => { readonly settings: Pick<SettingsRepository, 'get'> };
  readonly log: Logger | undefined;
  /** Pushes events to the window. Optional, so a removal on unlock is silent without it. */
  readonly emit?: (event: RpcEvent) => void;
  /**
   * Deletes the store file and points the router at a fresh store. Undefined when the store
   * cannot be reopened, so vault.reset fails with INTERNAL.
   */
  readonly resetStore: (() => void) | undefined;
}

/** Pushes an idle timeout (in minutes) from settings into the vault. */
export function applyIdleLock(vault: Pick<Vault, 'setIdleLockMs'>, minutes: number): void {
  vault.setIdleLockMs(minutes * MS_PER_MINUTE);
}

export function vaultOperations(deps: VaultDeps): [string, Operation][] {
  const repos = deps.repos;

  const resetVault = async (): Promise<void> => {
    const resetStore = deps.resetStore;
    if (resetStore === undefined) {
      throw new AppErrorException(appError('INTERNAL', 'The store cannot be reopened.'));
    }
    deps.vault.reset();
    await deps.connections.disconnectAll();
    await deps.docker?.cleanupAll();
    resetStore();
  };

  /**
   * Applies the stored timeout after unlock or setup. A stored value the router cannot apply
   * must not turn a successful unlock into an error, so the default stays and the failure is logged.
   */
  function applyStoredIdleLock(): void {
    try {
      applyIdleLock(deps.vault, repos().settings.get().idleLockMinutes);
    } catch (error) {
      const mapped = toAppError(error);
      deps.log?.warn('stored idle lock not applied, keeping the default', {
        code: mapped.code,
        error: mapped.message,
      });
    }
  }

  return [
    entry('vault.status', rpcContract.vault.status, () => deps.vault.status()),
    entry('vault.initialise', rpcContract.vault.initialise, (input) => {
      deps.vault.initialise(input.password);
      applyStoredIdleLock();
      deps.updates?.refreshSchedule();
    }),
    entry('vault.unlock', rpcContract.vault.unlock, async (input) => {
      await deps.vault.unlock(input.password);
      applyStoredIdleLock();
      void deps.docker?.pruneMissing(deps.emit);
      void deps.docker?.autoConnect();
      deps.docker?.resume();
      deps.updates?.refreshSchedule();
    }),
    entry('vault.lock', rpcContract.vault.lock, () => {
      deps.vault.lock();
    }),
    entry('vault.changePassword', rpcContract.vault.changePassword, async (input) => {
      await deps.vault.changePassword(input.current, input.next);
    }),
    entry('vault.reset', rpcContract.vault.reset, resetVault),
  ];
}
