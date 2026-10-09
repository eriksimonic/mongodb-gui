import { randomBytes } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppErrorException, appError, type VaultStatus } from '@mongo-gui/core';
import { DEFAULT_KDF_PARAMS, deriveKek, type KdfParams } from '../crypto/kdf';
import { DecryptError, open, seal } from '../crypto/aead';
import { readKeyringFile, removeKeyringFile, writeKeyringFile, type KeyringFile } from './keyring';

export interface VaultOptions {
  /** Directory that holds keyring.json. Created on initialise. */
  readonly dir: string;
  readonly kdf?: KdfParams;
  /** Locks the vault after this many milliseconds without activity. Defaults to 30 minutes. */
  readonly idleLockMs?: number;
  /** Delay applied after a failed unlock or password change. Defaults to 500 ms. */
  readonly failureDelayMs?: number;
  readonly now?: () => number;
  /** Called when the vault changes from unlocked to locked. */
  readonly onLocked?: () => void;
}

const MIN_PASSWORD_LENGTH = 10;
const SALT_BYTES = 32;
const DEK_BYTES = 32;
const KEYRING_FILE_NAME = 'keyring.json';
const DEK_AAD = Buffer.from('mongo-gui:dek:v1', 'utf8');
const DEFAULT_IDLE_LOCK_MS = 30 * 60 * 1000;
const DEFAULT_FAILURE_DELAY_MS = 500;
// setTimeout rejects delays above this and fires them after 1 ms instead.
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Owns the data encryption key (DEK). The master password derives a key-encryption key
 * (KEK) that wraps the DEK in keyring.json. The DEK exists in memory only while unlocked,
 * and other code reaches it only through withDek.
 */
export class Vault {
  readonly keyringPath: string;

  readonly #dir: string;
  readonly #kdf: KdfParams;
  #idleLockMs: number;
  readonly #failureDelayMs: number;
  readonly #now: () => number;
  readonly #onLocked: (() => void) | undefined;

  #dek: Buffer | undefined;
  #lastActivity = 0;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: VaultOptions) {
    this.#dir = options.dir;
    this.keyringPath = join(options.dir, KEYRING_FILE_NAME);
    this.#kdf = options.kdf ?? DEFAULT_KDF_PARAMS;
    this.#idleLockMs = options.idleLockMs ?? DEFAULT_IDLE_LOCK_MS;
    this.#failureDelayMs = options.failureDelayMs ?? DEFAULT_FAILURE_DELAY_MS;
    this.#now = options.now ?? Date.now;
    this.#onLocked = options.onLocked;
  }

  status(): VaultStatus {
    if (!existsSync(this.keyringPath)) {
      return { state: 'uninitialised' };
    }
    return { state: this.#dek === undefined ? 'locked' : 'unlocked' };
  }

  /** Creates a new DEK under the given password and leaves the vault unlocked. */
  initialise(password: string): void {
    assertPasswordLength(password);
    if (existsSync(this.keyringPath)) {
      throw new AppErrorException(appError('VALIDATION', 'The vault is already initialised.'));
    }
    const salt = randomBytes(SALT_BYTES);
    const dek = randomBytes(DEK_BYTES);
    const keyring = this.#wrap(password, salt, dek);
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    writeKeyringFile(this.keyringPath, keyring);
    this.#install(dek);
  }

  /**
   * Unwraps the DEK and leaves the vault unlocked. A wrong password waits for the
   * failure delay and then throws VAULT_BAD_PASSWORD.
   */
  async unlock(password: string): Promise<void> {
    const keyring = this.#requireKeyring();
    const dek = await this.#unwrap(keyring, password);
    this.#install(dek);
  }

  /** Zeroes the DEK, drops it, and calls onLocked when the vault was unlocked. */
  lock(): void {
    if (this.#dek === undefined) {
      return;
    }
    this.#clearDek();
    this.#onLocked?.();
  }

  /**
   * Rewraps the same DEK under a new salt and password. Encrypted data is not touched.
   */
  async changePassword(current: string, next: string): Promise<void> {
    assertPasswordLength(next);
    const keyring = this.#requireKeyring();
    const dek = await this.#unwrap(keyring, current);
    try {
      writeKeyringFile(this.keyringPath, this.#wrap(next, randomBytes(SALT_BYTES), dek));
    } finally {
      dek.fill(0);
    }
  }

  /** Locks the vault and deletes keyring.json. The caller deletes the store file. */
  reset(): void {
    this.lock();
    removeKeyringFile(this.keyringPath);
  }

  /**
   * Runs fn with the DEK. Throws VAULT_LOCKED when the vault is locked.
   * Each call counts as activity for the idle timer. The callback must be synchronous:
   * if the vault locked during an await, the callback would use a zeroed key.
   */
  withDek<T>(fn: (dek: Buffer) => T extends PromiseLike<unknown> ? never : T): T {
    const dek = this.#dek;
    if (dek === undefined) {
      throw new AppErrorException(appError('VAULT_LOCKED', 'The vault is locked.'));
    }
    this.touch();
    const result: unknown = fn(dek);
    if (isThenable(result)) {
      // Attach a handler so a rejecting async body does not surface as an unhandled rejection.
      result.then(undefined, () => undefined);
      throw new AppErrorException(appError('INTERNAL', 'withDek callbacks must be synchronous.'));
    }
    return result as T;
  }

  /**
   * Changes the idle timeout. When the vault is unlocked the timer is re-armed against the
   * time already idle, so a shorter timeout can lock the vault at once.
   */
  setIdleLockMs(ms: number): void {
    if (Number.isNaN(ms)) {
      throw new AppErrorException(appError('VALIDATION', 'The idle lock must be a number.'));
    }
    // Values outside the timer range are clamped, so a stored value can never break the timer.
    const clamped = Math.min(Math.max(1, Math.floor(ms)), Number.MAX_SAFE_INTEGER);
    this.#idleLockMs = clamped;
    if (this.#dek === undefined) {
      return;
    }
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    const idleFor = this.#now() - this.#lastActivity;
    this.#armIdleTimer(Math.max(0, clamped - idleFor));
  }

  /** Records activity and arms the idle timer. Does nothing while the vault is locked. */
  touch(): void {
    if (this.#dek === undefined) {
      return;
    }
    this.#lastActivity = this.#now();
    if (this.#idleTimer === undefined) {
      this.#armIdleTimer(this.#idleLockMs);
    }
  }

  #armIdleTimer(delayMs: number): void {
    const timer = setTimeout(() => this.#onIdleTimer(), Math.min(delayMs, MAX_TIMER_MS));
    timer.unref();
    this.#idleTimer = timer;
  }

  #onIdleTimer(): void {
    this.#idleTimer = undefined;
    if (this.#dek === undefined) {
      return;
    }
    const idleFor = this.#now() - this.#lastActivity;
    if (idleFor >= this.#idleLockMs) {
      this.lock();
      return;
    }
    this.#armIdleTimer(this.#idleLockMs - idleFor);
  }

  #install(dek: Buffer): void {
    this.#clearDek();
    this.#dek = dek;
    this.touch();
  }

  #clearDek(): void {
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    this.#dek?.fill(0);
    this.#dek = undefined;
  }

  #requireKeyring(): KeyringFile {
    const keyring = readKeyringFile(this.keyringPath);
    if (keyring === undefined) {
      throw new AppErrorException(
        appError('VAULT_NOT_INITIALISED', 'The vault has not been set up yet.'),
      );
    }
    return keyring;
  }

  #wrap(password: string, salt: Buffer, dek: Buffer): KeyringFile {
    const kek = deriveKek(password, salt, this.#kdf);
    try {
      return {
        version: 1,
        kdf: { salt: salt.toString('base64'), N: this.#kdf.N, r: this.#kdf.r, p: this.#kdf.p },
        wrappedDek: seal(kek, dek, DEK_AAD).toString('base64'),
      };
    } finally {
      kek.fill(0);
    }
  }

  async #unwrap(keyring: KeyringFile, password: string): Promise<Buffer> {
    const salt = Buffer.from(keyring.kdf.salt, 'base64');
    const wrapped = Buffer.from(keyring.wrappedDek, 'base64');
    const kek = deriveKek(password, salt, {
      N: keyring.kdf.N,
      r: keyring.kdf.r,
      p: keyring.kdf.p,
    });
    let dek: Buffer | undefined;
    try {
      dek = open(kek, wrapped, DEK_AAD);
    } catch (error) {
      if (!(error instanceof DecryptError)) {
        throw error;
      }
    } finally {
      kek.fill(0);
    }
    if (dek === undefined) {
      await delay(this.#failureDelayMs);
      throw new AppErrorException(
        appError('VAULT_BAD_PASSWORD', 'The master password is incorrect.'),
      );
    }
    return dek;
  }
}

function assertPasswordLength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AppErrorException(
      appError(
        'VALIDATION',
        `The master password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      ),
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}
