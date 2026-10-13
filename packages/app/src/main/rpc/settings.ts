import { rpcContract } from '@mongo-gui/core';
import type {
  FavouritesRepository,
  HistoryRepository,
  LayoutRepository,
  SettingsRepository,
  Vault,
} from '@mongo-gui/storage';
import type { Updater } from '../updates/updater';
import { entry, type Operation } from './operation';
import { applyIdleLock } from './vault';

export interface SettingsDeps {
  readonly repos: () => {
    readonly settings: SettingsRepository;
    readonly layout: LayoutRepository;
    readonly history: HistoryRepository;
    readonly favourites: FavouritesRepository;
  };
  readonly vault: Pick<Vault, 'setIdleLockMs'>;
  readonly updates: Pick<Updater, 'refreshSchedule'> | undefined;
}

export function settingsOperations(deps: SettingsDeps): [string, Operation][] {
  const repos = deps.repos;
  return [
    entry('layout.get', rpcContract.layout.get, (input) => ({
      value: repos().layout.get(input.key) ?? null,
    })),
    entry('layout.set', rpcContract.layout.set, (input) => {
      repos().layout.set(input.key, input.value);
    }),

    entry('settings.get', rpcContract.settings.get, () => repos().settings.get()),
    entry('settings.update', rpcContract.settings.update, (input) => {
      // The timeout is applied before the value is stored, so a value the vault rejects is never saved.
      if (input.idleLockMinutes !== undefined) {
        applyIdleLock(deps.vault, input.idleLockMinutes);
      }
      const saved = repos().settings.update(input);
      if (input.checkForUpdates !== undefined) {
        deps.updates?.refreshSchedule();
      }
      return saved;
    }),

    entry('history.list', rpcContract.history.list, (input) => repos().history.list(input)),
    entry('history.append', rpcContract.history.append, (input) => repos().history.append(input)),
    entry('history.clear', rpcContract.history.clear, () => {
      repos().history.clear();
    }),

    entry('favourites.list', rpcContract.favourites.list, () => repos().favourites.list()),
    entry('favourites.save', rpcContract.favourites.save, (input) =>
      repos().favourites.save(input),
    ),
    entry('favourites.remove', rpcContract.favourites.remove, (input) => {
      repos().favourites.remove(input.id);
    }),
  ];
}
