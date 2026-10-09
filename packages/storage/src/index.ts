/// <reference types="node" />
// Packages that compile this source directly, such as app, do not set Node types.

export const storagePackageName = '@mongo-gui/storage';

export { DEFAULT_KDF_PARAMS, deriveKek, type KdfParams } from './crypto/kdf';
export { DecryptError, open, seal, type DecryptFailure } from './crypto/aead';
export { Vault, type VaultOptions } from './vault/vault';
export {
  EncryptedStore,
  type EncryptedStoreOptions,
  type StoreTable,
} from './store/encrypted-store';
export { ConnectionsRepository } from './store/connections-repo';
export {
  HistoryRepository,
  type HistoryAppendInput,
  type HistoryListQuery,
} from './store/history-repo';
export { FavouritesRepository } from './store/favourites-repo';
export { SettingsRepository } from './store/settings-repo';
export { LayoutRepository } from './store/layout-repo';
