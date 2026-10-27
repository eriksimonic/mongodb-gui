import { randomBytes } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  AppErrorException,
  appError,
  type DeviceKeyAvailability,
  type VaultMode,
  type VaultStatus,
} from '@mongo-gui/core';
import { DEFAULT_KDF_PARAMS, deriveKek, type KdfParams } from '../crypto/kdf';
import { DecryptError, open, seal } from '../crypto/aead';
import {
  keyringMode,
  readKeyringFile,
  removeKeyringFile,
  writeKeyringFile,
  type KeyringFile,
  type PasswordKeyring,
} from './keyring';

/** Wraps and unwraps the DEK with a key that the operating system protects for the current user. */
export interface DeviceKeyProvider {
  availability(): DeviceKeyAvailability;
  encrypt(dek: Buffer): Buffer;
  decrypt(wrapped: Buffer): Buffer;
}

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
  /** Called after initialise or unlock leaves the vault unlocked. */
  readonly onUnlocked?: () => void;
  /** Provides machine encryption. Without it, machine encryption is unavailable. */
  readonly deviceKey?: DeviceKeyProvider;
}

const MIN_PASSWORD_LENGTH = 4;
const DEVICE_KEY_FAILED = 'This machine could not open the vault key.';
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
  readonly #onUnlocked: (() => void) | undefined;
  readonly #deviceKey: DeviceKeyProvider | undefined;

  #dek: Buffer | undefined;
  #mode: VaultMode | undefined;
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
    this.#onUnlocked = options.onUnlocked;
    this.#deviceKey = options.deviceKey;
  }

  status(): VaultStatus {
    if (!existsSync(this.keyringPath)) {
      return { state: 'uninitialised' };
    }
    return { state: this.#dek === undefined ? 'locked' : 'unlocked', mode: this.#fileMode() };
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
    this.#mode = 'password';
    this.#install(dek);
    this.#onUnlocked?.();
  }

  /**
   * Unwraps the DEK and leaves the vault unlocked. A wrong password waits for the
   * failure delay and then throws VAULT_BAD_PASSWORD.
   */
  async unlock(password: string): Promise<void> {
    const keyring = this.#requirePasswordKeyring();
    const dek = await this.#unwrap(keyring, password);
    this.#mode = 'password';
    this.#install(dek);
    this.#onUnlocked?.();
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
    const keyring = this.#requirePasswordKeyring();
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
    this.#mode = undefined;
    removeKeyringFile(this.keyringPath);
  }

  /** Reports whether machine encryption can be used on this system. */
  deviceKeyAvailability(): DeviceKeyAvailability {
    return this.#deviceKey?.availability() ?? { available: false, reason: 'no-encryption' };
  }

  /** Creates a new DEK wrapped by the device key and leaves the vault unlocked. */
  initialiseDevice(): void {
    if (existsSync(this.keyringPath)) {
      throw new AppErrorException(appError('VALIDATION', 'The vault is already initialised.'));
    }
    const provider = this.#requireDeviceKey();
    const dek = randomBytes(DEK_BYTES);
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    writeKeyringFile(this.keyringPath, {
      version: 2,
      mode: 'device',
      wrappedDek: provider.encrypt(dek).toString('base64'),
    });
    this.#mode = 'device';
    this.#install(dek);
    this.#onUnlocked?.();
  }

  /** Unwraps the DEK with the device key and leaves the vault unlocked. */
  unlockDevice(): void {
    const keyring = this.#requireKeyring();
    if (keyring.version === 1) {
      throw new AppErrorException(appError('VALIDATION', 'The vault uses a master password.'));
    }
    const provider = this.#deviceKey;
    if (provider === undefined) {
      throw new AppErrorException(appError('INTERNAL', DEVICE_KEY_FAILED));
    }
    let dek: Buffer;
    try {
      dek = provider.decrypt(Buffer.from(keyring.wrappedDek, 'base64'));
    } catch {
      throw new AppErrorException(appError('INTERNAL', DEVICE_KEY_FAILED));
    }
    if (dek.length !== DEK_BYTES) {
      dek.fill(0);
      throw new AppErrorException(appError('INTERNAL', DEVICE_KEY_FAILED));
    }
    this.#mode = 'device';
    this.#install(dek);
    this.#onUnlocked?.();
  }

  /**
   * Switches a machine-encrypted vault to a master password. The live DEK stays in memory,
   * so it is not zeroed here.
   */
  setPassword(next: string): void {
    assertPasswordLength(next);
    const keyring = this.#requireKeyring();
    if (keyring.version === 1) {
      throw new AppErrorException(appError('VALIDATION', 'The vault uses a master password.'));
    }
    const dek = this.#dek;
    if (dek === undefined) {
      throw new AppErrorException(appError('VAULT_LOCKED', 'The vault is locked.'));
    }
    writeKeyringFile(this.keyringPath, this.#wrap(next, randomBytes(SALT_BYTES), dek));
    this.#mode = 'password';
    this.touch();
  }

  /** Switches a password vault to machine encryption. Needs the current master password. */
  async removePassword(current: string): Promise<void> {
    const keyring = this.#requirePasswordKeyring();
    const provider = this.#requireDeviceKey();
    const dek = await this.#unwrap(keyring, current);
    try {
      writeKeyringFile(this.keyringPath, {
        version: 2,
        mode: 'device',
        wrappedDek: provider.encrypt(dek).toString('base64'),
      });
    } finally {
      dek.fill(0);
    }
    this.#mode = 'device';
    this.#clearIdleTimer();
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
    if (this.#dek === undefined || this.#mode === 'device') {
      return;
    }
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    const idleFor = this.#now() - this.#lastActivity;
    this.#armIdleTimer(Math.max(0, clamped - idleFor));
  }

  /**
   * Records activity and arms the idle timer. Does nothing while the vault is locked or
   * uses machine encryption, because the device key unlocks it again at once.
   */
  touch(): void {
    if (this.#dek === undefined || this.#mode === 'device') {
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

  #clearIdleTimer(): void {
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
  }

  #clearDek(): void {
    this.#clearIdleTimer();
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

  #requirePasswordKeyring(): PasswordKeyring {
    const keyring = this.#requireKeyring();
    if (keyring.version === 2) {
      throw new AppErrorException(
        appError('VALIDATION', 'The vault uses machine encryption and has no master password.'),
      );
    }
    return keyring;
  }

  #requireDeviceKey(): DeviceKeyProvider {
    const provider = this.#deviceKey;
    if (provider === undefined || !provider.availability().available) {
      throw new AppErrorException(
        appError('VALIDATION', 'Machine encryption is not available on this system.'),
      );
    }
    return provider;
  }

  /** Reads the mode from keyring.json. A malformed file counts as password mode. */
  #fileMode(): VaultMode {
    try {
      const keyring = readKeyringFile(this.keyringPath);
      return keyring === undefined ? 'password' : keyringMode(keyring);
    } catch {
      // The unlock screen and its reset button still show for a malformed file.
      return 'password';
    }
  }

  #wrap(password: string, salt: Buffer, dek: Buffer): PasswordKeyring {
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

  async #unwrap(keyring: PasswordKeyring, password: string): Promise<Buffer> {
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
