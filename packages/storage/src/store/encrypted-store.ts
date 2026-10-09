import { chmodSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { AppErrorException, appError } from '@mongo-gui/core';
import { DecryptError, open, seal } from '../crypto/aead';
import type { Vault } from '../vault/vault';
import { applyMigrations } from './migrations';
import { parseStored, type PayloadSchema } from './validation';

export type StoreTable = 'connections' | 'history' | 'favourites' | 'settings' | 'layout';

export interface EncryptedStoreOptions {
  readonly path: string;
  readonly vault: Vault;
}

const MEMORY_PATH = ':memory:';
const SIDECAR_SUFFIXES = ['', '-wal', '-shm'] as const;
const STORE_FILE_MODE = 0o600;

/**
 * SQLite file whose payload columns hold AES-256-GCM ciphertext under the vault DEK.
 * The AAD is `table:id`, so a payload copied to another row fails to decrypt.
 */
export class EncryptedStore {
  readonly #path: string;
  readonly #vault: Vault;
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(options: EncryptedStoreOptions) {
    this.#path = options.path;
    this.#vault = options.vault;
    this.#db = new DatabaseSync(options.path);
    restrictToOwner(options.path);
    try {
      this.#db.exec('PRAGMA journal_mode = WAL');
      this.#db.exec('PRAGMA foreign_keys = ON');
      applyMigrations(this.#db);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  /** The open database. Repositories run their SQL through it. */
  get db(): DatabaseSync {
    if (this.#closed) {
      throw new AppErrorException(appError('INTERNAL', 'store is closed'));
    }
    return this.#db;
  }

  /** Throws VAULT_LOCKED when the vault is locked. Repositories call it before any work. */
  assertUnlocked(): void {
    this.#vault.withDek(() => undefined);
  }

  encryptPayload(table: StoreTable, id: string, value: unknown): Buffer {
    const json = JSON.stringify(value);
    if (json === undefined) {
      throw new AppErrorException(appError('VALIDATION', 'The value cannot be stored as JSON.'));
    }
    const plaintext = Buffer.from(json, 'utf8');
    return this.#vault.withDek((dek) => seal(dek, plaintext, aadFor(table, id)));
  }

  /**
   * Opens a payload and validates the decoded value. A tampered, moved or malformed
   * payload throws INTERNAL.
   */
  decryptPayload<T>(table: StoreTable, id: string, blob: Uint8Array, schema: PayloadSchema<T>): T {
    const sealed = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
    const plaintext = this.#vault.withDek((dek) => {
      try {
        return open(dek, sealed, aadFor(table, id));
      } catch (error) {
        if (error instanceof DecryptError) {
          throw corruptRecord(table);
        }
        throw error;
      }
    });
    let value: unknown;
    try {
      value = JSON.parse(plaintext.toString('utf8'));
    } catch {
      throw corruptRecord(table);
    } finally {
      plaintext.fill(0);
    }
    return parseStored(schema, value, `${table} record`);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#db.close();
    this.#closed = true;
  }

  /** Closes the store and removes the database file with its -wal and -shm sidecars. */
  deleteFile(): void {
    this.close();
    if (this.#path === MEMORY_PATH) {
      return;
    }
    for (const suffix of SIDECAR_SUFFIXES) {
      rmSync(this.#path + suffix, { force: true });
    }
  }
}

/** Owner read and write only. Windows ignores POSIX modes, so it is skipped there. */
function restrictToOwner(path: string): void {
  if (path === MEMORY_PATH || process.platform === 'win32') {
    return;
  }
  chmodSync(path, STORE_FILE_MODE);
}

function aadFor(table: StoreTable, id: string): Buffer {
  return Buffer.from(`${table}:${id}`, 'utf8');
}

function corruptRecord(table: StoreTable): AppErrorException {
  return new AppErrorException(
    appError('INTERNAL', `A ${table} record could not be decrypted. It may be damaged.`),
  );
}
