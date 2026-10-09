import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectionProfileInput } from '@mongo-gui/core';
import { Vault } from '../vault/vault';
import { EncryptedStore } from './encrypted-store';
import { ConnectionsRepository } from './connections-repo';
import { FavouritesRepository } from './favourites-repo';
import { HistoryRepository } from './history-repo';
import { LayoutRepository } from './layout-repo';
import { SettingsRepository } from './settings-repo';

/** Test-only helpers. Production code does not import this file. */

export const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
export const TEST_PASSWORD = 'correct horse battery';

export interface TestStore {
  readonly dir: string;
  readonly storePath: string;
  readonly vault: Vault;
  readonly store: EncryptedStore;
  readonly connections: ConnectionsRepository;
  readonly history: HistoryRepository;
  readonly favourites: FavouritesRepository;
  readonly settings: SettingsRepository;
  readonly layout: LayoutRepository;
  dispose(): void;
}

/** Creates a temp directory, an initialised unlocked vault, and a store file in it. */
export function openTestStore(): TestStore {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const storePath = join(dir, 'store.sqlite');
  const vault = new Vault({ dir, kdf: FAST_KDF, failureDelayMs: 0 });
  vault.initialise(TEST_PASSWORD);
  const store = new EncryptedStore({ path: storePath, vault });
  const settings = new SettingsRepository(store);
  return {
    dir,
    storePath,
    vault,
    store,
    connections: new ConnectionsRepository(store),
    history: new HistoryRepository(store, settings),
    favourites: new FavouritesRepository(store),
    settings,
    layout: new LayoutRepository(store),
    dispose(): void {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function connectionInput(
  overrides: Partial<ConnectionProfileInput> = {},
): ConnectionProfileInput {
  return { name: 'Local', uri: 'mongodb://localhost:27017', ...overrides };
}
