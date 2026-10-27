import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppErrorException, type AppErrorCode } from '@mongo-gui/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DecryptError, open, seal } from '../crypto/aead';
import { Vault, type DeviceKeyProvider, type VaultOptions } from './vault';
import { readKeyringFile } from './keyring';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';
const OTHER_PASSWORD = 'staple lantern cobalt';
const PLAIN = Buffer.from('mongodb://user:secret@host/db', 'utf8');
const AAD = Buffer.from('connections:row-1', 'utf8');

let dirs: string[];

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vault-'));
  dirs.push(dir);
  return dir;
}

function newVault(dir: string, options: Partial<VaultOptions> = {}): Vault {
  return new Vault({ dir, kdf: FAST_KDF, failureDelayMs: 0, ...options });
}

async function expectCode(action: () => unknown, code: AppErrorCode): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppErrorException);
  expect(caught).toMatchObject({ error: { code } });
}

function keyringSalt(path: string): string | undefined {
  const keyring = readKeyringFile(path);
  return keyring?.version === 1 ? keyring.kdf.salt : undefined;
}

beforeEach(() => {
  dirs = [];
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Vault lifecycle', () => {
  it('reports uninitialised, then unlocked after initialise', () => {
    const vault = newVault(newDir());
    expect(vault.status()).toEqual({ state: 'uninitialised' });
    vault.initialise(PASSWORD);
    expect(vault.status()).toEqual({ state: 'unlocked', mode: 'password' });
    vault.lock();
  });

  it('locks, then unlocks with the same password', async () => {
    const vault = newVault(newDir());
    vault.initialise(PASSWORD);
    vault.lock();
    expect(vault.status()).toEqual({ state: 'locked', mode: 'password' });
    await vault.unlock(PASSWORD);
    expect(vault.status()).toEqual({ state: 'unlocked', mode: 'password' });
    vault.lock();
  });

  it('rejects a password shorter than 4 characters', () => {
    const vault = newVault(newDir());
    expect(() => {
      vault.initialise('123');
    }).toThrow(AppErrorException);
    expect(vault.status()).toEqual({ state: 'uninitialised' });
  });

  it('rejects initialise when the vault already exists', () => {
    const vault = newVault(newDir());
    vault.initialise(PASSWORD);
    vault.lock();
    expect(() => {
      vault.initialise(OTHER_PASSWORD);
    }).toThrow(AppErrorException);
  });

  it('throws VAULT_NOT_INITIALISED when unlocking a vault with no keyring', async () => {
    await expectCode(() => newVault(newDir()).unlock(PASSWORD), 'VAULT_NOT_INITIALISED');
  });

  it('throws VAULT_BAD_PASSWORD for a wrong password and stays locked', async () => {
    const dir = newDir();
    const vault = newVault(dir);
    vault.initialise(PASSWORD);
    vault.lock();
    await expectCode(() => vault.unlock(OTHER_PASSWORD), 'VAULT_BAD_PASSWORD');
    expect(vault.status()).toEqual({ state: 'locked', mode: 'password' });
    await vault.unlock(PASSWORD);
    expect(vault.status()).toEqual({ state: 'unlocked', mode: 'password' });
    vault.lock();
  });

  it('waits 500 ms before reporting a wrong password by default', async () => {
    vi.useFakeTimers();
    const dir = newDir();
    const seed = newVault(dir);
    seed.initialise(PASSWORD);
    seed.lock();
    const vault = new Vault({ dir, kdf: FAST_KDF });
    let settled = false;
    const attempt = vault.unlock(OTHER_PASSWORD).catch((error: unknown) => {
      settled = true;
      throw error;
    });
    const outcome = expect(attempt).rejects.toMatchObject({
      error: { code: 'VAULT_BAD_PASSWORD' },
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(settled).toBe(true);
  });

  it('gives a different salt and DEK to each vault', () => {
    const first = newVault(newDir());
    const second = newVault(newDir());
    first.initialise(PASSWORD);
    second.initialise(PASSWORD);
    const firstKeyring = readKeyringFile(first.keyringPath);
    const secondKeyring = readKeyringFile(second.keyringPath);
    expect(keyringSalt(first.keyringPath)).not.toBe(keyringSalt(second.keyringPath));
    expect(firstKeyring?.wrappedDek).not.toBe(secondKeyring?.wrappedDek);
    first.lock();
    second.lock();
  });
});

describe('Vault lock', () => {
  it('makes withDek throw VAULT_LOCKED', async () => {
    const vault = newVault(newDir());
    vault.initialise(PASSWORD);
    vault.lock();
    expect(() => vault.withDek(() => 'read')).toThrow(AppErrorException);
    expect(() => vault.withDek(() => 'read')).toThrow('The vault is locked.');
    await vault.unlock(PASSWORD);
    expect(vault.withDek(() => 'read')).toBe('read');
    vault.lock();
  });

  it('zero-fills the DEK buffer it handed out', () => {
    const vault = newVault(newDir());
    vault.initialise(PASSWORD);
    let captured: Buffer | undefined;
    vault.withDek((dek) => {
      captured = dek;
    });
    expect(captured?.every((byte) => byte === 0)).toBe(false);
    vault.lock();
    expect(captured?.every((byte) => byte === 0)).toBe(true);
  });

  it('calls onLocked once when an unlocked vault locks, and not when already locked', () => {
    const onLocked = vi.fn();
    const vault = newVault(newDir(), { onLocked });
    vault.initialise(PASSWORD);
    vault.lock();
    vault.lock();
    expect(onLocked).toHaveBeenCalledTimes(1);
  });
});

describe('Vault changePassword', () => {
  it('keeps data readable under the same DEK after the password changes', async () => {
    const dir = newDir();
    const vault = newVault(dir);
    vault.initialise(PASSWORD);
    const sealed = vault.withDek((dek) => seal(dek, PLAIN, AAD));
    await vault.changePassword(PASSWORD, OTHER_PASSWORD);
    vault.lock();

    await expectCode(() => vault.unlock(PASSWORD), 'VAULT_BAD_PASSWORD');
    await vault.unlock(OTHER_PASSWORD);
    const reopened = vault.withDek((dek) => open(dek, sealed, AAD));
    expect(reopened.equals(PLAIN)).toBe(true);
    vault.lock();
  });

  it('gives the keyring a new salt', async () => {
    const vault = newVault(newDir());
    vault.initialise(PASSWORD);
    vault.lock();
    const before = keyringSalt(vault.keyringPath);
    await vault.changePassword(PASSWORD, OTHER_PASSWORD);
    expect(keyringSalt(vault.keyringPath)).not.toBe(before);
  });

  it('rejects a wrong current password without changing the keyring', async () => {
    const vault = newVault(newDir());
    vault.initialise(PASSWORD);
    vault.lock();
    const before = readFileSync(vault.keyringPath, 'utf8');
    await expectCode(
      () => vault.changePassword(OTHER_PASSWORD, 'another long password'),
      'VAULT_BAD_PASSWORD',
    );
    expect(readFileSync(vault.keyringPath, 'utf8')).toBe(before);
  });

  it('rejects a new password shorter than 4 characters', async () => {
    const vault = newVault(newDir());
    vault.initialise(PASSWORD);
    vault.lock();
    await expectCode(() => vault.changePassword(PASSWORD, 'abc'), 'VALIDATION');
  });
});

describe('Vault reset', () => {
  it('deletes the keyring and locks the vault', () => {
    const vault = newVault(newDir());
    vault.initialise(PASSWORD);
    vault.reset();
    expect(vault.status()).toEqual({ state: 'uninitialised' });
    expect(() => vault.withDek(() => undefined)).toThrow(AppErrorException);
  });
});

describe('Vault keyring copied from another vault', () => {
  it('cannot unwrap the DEK that protects this vault data', async () => {
    const dirA = newDir();
    const dirB = newDir();
    const vaultA = newVault(dirA);
    const vaultB = newVault(dirB);
    vaultA.initialise(PASSWORD);
    vaultB.initialise(PASSWORD);
    const sealedByB = vaultB.withDek((dek) => seal(dek, PLAIN, AAD));
    vaultB.lock();

    copyFileSync(vaultA.keyringPath, vaultB.keyringPath);
    vaultA.lock();
    await vaultB.unlock(PASSWORD);
    expect(() => vaultB.withDek((dek) => open(dek, sealedByB, AAD))).toThrow(DecryptError);
    vaultB.lock();
  });
});

describe('Vault idle lock', () => {
  it('locks after idleLockMs without activity', () => {
    vi.useFakeTimers();
    let clock = 0;
    const vault = newVault(newDir(), { idleLockMs: 1000, now: () => clock });
    vault.initialise(PASSWORD);

    clock = 900;
    vault.withDek(() => undefined);
    clock = 1000;
    vi.advanceTimersByTime(1000);
    expect(vault.status()).toEqual({ state: 'unlocked', mode: 'password' });

    clock = 1900;
    vi.advanceTimersByTime(900);
    expect(vault.status()).toEqual({ state: 'locked', mode: 'password' });
  });

  it('calls onLocked when the idle timer locks the vault', () => {
    vi.useFakeTimers();
    let clock = 0;
    const onLocked = vi.fn();
    const vault = newVault(newDir(), { idleLockMs: 1000, now: () => clock, onLocked });
    vault.initialise(PASSWORD);
    clock = 1000;
    vi.advanceTimersByTime(1000);
    expect(onLocked).toHaveBeenCalledTimes(1);
    expect(vault.status()).toEqual({ state: 'locked', mode: 'password' });
  });

  it('leaves no timer running after lock', () => {
    vi.useFakeTimers();
    const vault = newVault(newDir(), { idleLockMs: 1000 });
    vault.initialise(PASSWORD);
    vault.lock();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('setIdleLockMs shortens a running timer and re-arms it against the idle time', () => {
    vi.useFakeTimers();
    let clock = 0;
    const vault = newVault(newDir(), { idleLockMs: 1000, now: () => clock });
    vault.initialise(PASSWORD);

    clock = 300;
    vault.setIdleLockMs(500);
    clock = 500;
    vi.advanceTimersByTime(200);
    expect(vault.status()).toEqual({ state: 'locked', mode: 'password' });
  });

  it('setIdleLockMs lengthens the timeout without locking early', () => {
    vi.useFakeTimers();
    let clock = 0;
    const vault = newVault(newDir(), { idleLockMs: 1000, now: () => clock });
    vault.initialise(PASSWORD);

    clock = 900;
    vault.setIdleLockMs(5000);
    clock = 1000;
    vi.advanceTimersByTime(1000);
    expect(vault.status()).toEqual({ state: 'unlocked', mode: 'password' });

    clock = 5000;
    vi.advanceTimersByTime(4000);
    expect(vault.status()).toEqual({ state: 'locked', mode: 'password' });
  });

  it('setIdleLockMs locks at once when the vault is already idle past the new timeout', () => {
    vi.useFakeTimers();
    let clock = 0;
    const onLocked = vi.fn();
    const vault = newVault(newDir(), { idleLockMs: 10_000, now: () => clock, onLocked });
    vault.initialise(PASSWORD);

    clock = 2000;
    vault.setIdleLockMs(500);
    vi.advanceTimersByTime(1);
    expect(vault.status()).toEqual({ state: 'locked', mode: 'password' });
    expect(onLocked).toHaveBeenCalledTimes(1);
  });

  it('setIdleLockMs clamps a timeout below 1 ms to 1 ms', () => {
    vi.useFakeTimers();
    let clock = 0;
    const vault = newVault(newDir(), { idleLockMs: 1000, now: () => clock });
    vault.initialise(PASSWORD);
    vault.setIdleLockMs(0);
    clock = 1;
    vi.advanceTimersByTime(1);
    expect(vault.status()).toEqual({ state: 'locked', mode: 'password' });
  });

  it('setIdleLockMs clamps an out-of-range timeout without throwing or looping', () => {
    vi.useFakeTimers();
    const vault = newVault(newDir(), { idleLockMs: 1000, now: () => 0 });
    vault.initialise(PASSWORD);

    expect(() => vault.setIdleLockMs(1e15)).not.toThrow();
    expect(() => vault.setIdleLockMs(Number.POSITIVE_INFINITY)).not.toThrow();
    // One pending timer, armed at the largest delay setTimeout accepts.
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(vault.status()).toEqual({ state: 'unlocked', mode: 'password' });
  });

  it('setIdleLockMs still rejects NaN', () => {
    const vault = newVault(newDir(), { idleLockMs: 1000 });
    vault.initialise(PASSWORD);
    expect(() => vault.setIdleLockMs(Number.NaN)).toThrow(AppErrorException);
  });

  it('setIdleLockMs arms no timer while locked', () => {
    vi.useFakeTimers();
    const vault = newVault(newDir(), { idleLockMs: 1000 });
    vault.initialise(PASSWORD);
    vault.lock();
    vault.setIdleLockMs(500);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does nothing when touched while locked', () => {
    vi.useFakeTimers();
    const vault = newVault(newDir(), { idleLockMs: 1000 });
    vault.initialise(PASSWORD);
    vault.lock();
    vault.touch();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Vault KDF parameters', () => {
  it('unlocks with the parameters stored in the keyring, not the constructor options', async () => {
    const dir = newDir();
    const writer = newVault(dir, { kdf: { N: 2 ** 10, r: 8, p: 1 } });
    writer.initialise(PASSWORD);
    writer.lock();
    const reader = new Vault({ dir, kdf: { N: 2 ** 12, r: 8, p: 1 }, failureDelayMs: 0 });
    await reader.unlock(PASSWORD);
    expect(reader.status()).toEqual({ state: 'unlocked', mode: 'password' });
    reader.lock();
  });
});

describe('Vault withDek synchronous callbacks', () => {
  it('rejects an async callback at compile time', () => {
    const vault = newVault(newDir());
    vault.initialise(PASSWORD);
    // @ts-expect-error withDek callbacks must be synchronous
    expect(() => vault.withDek(async () => 1)).toThrow(AppErrorException);
    vault.lock();
  });

  it('throws INTERNAL at runtime when the callback returns a promise', () => {
    const vault = newVault(newDir());
    vault.initialise(PASSWORD);
    const asyncCallback = (() => Promise.resolve(1)) as unknown as (dek: Buffer) => number;
    expect(() => vault.withDek(asyncCallback)).toThrow(AppErrorException);
    expect(() => vault.withDek(asyncCallback)).toThrow('withDek callbacks must be synchronous.');
    vault.lock();
  });
});

describe('Vault reset with a leftover temporary file', () => {
  it('removes the temporary keyring too', () => {
    const dir = newDir();
    const vault = newVault(dir);
    vault.initialise(PASSWORD);
    writeFileSync(`${vault.keyringPath}.tmp`, 'leftover');
    vault.reset();
    expect(existsSync(`${vault.keyringPath}.tmp`)).toBe(false);
    expect(vault.status()).toEqual({ state: 'uninitialised' });
  });
});

const MARKER = Buffer.from('DKEY', 'utf8');
const deviceKey: DeviceKeyProvider = {
  availability: () => ({ available: true }),
  encrypt: (dek) => Buffer.concat([MARKER, dek]),
  decrypt: (wrapped) => {
    if (!wrapped.subarray(0, MARKER.length).equals(MARKER)) {
      throw new Error('not wrapped by this device');
    }
    return Buffer.from(wrapped.subarray(MARKER.length));
  },
};
const unavailableKey: DeviceKeyProvider = {
  ...deviceKey,
  availability: () => ({ available: false, reason: 'basic-text' }),
};

function copyDek(vault: Vault): Buffer {
  return vault.withDek((dek) => Buffer.from(dek));
}

async function expectInternal(action: () => unknown): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({
    error: { code: 'INTERNAL', message: 'This machine could not open the vault key.' },
  });
}

describe('Vault machine encryption', () => {
  it('initialiseDevice writes a version 2 keyring and leaves the vault unlocked', () => {
    const vault = newVault(newDir(), { deviceKey });
    vault.initialiseDevice();
    expect(readKeyringFile(vault.keyringPath)).toMatchObject({ version: 2, mode: 'device' });
    expect(vault.status()).toEqual({ state: 'unlocked', mode: 'device' });
  });

  it('unlockDevice restores the same DEK after lock', () => {
    const vault = newVault(newDir(), { deviceKey });
    vault.initialiseDevice();
    const before = copyDek(vault);
    vault.lock();
    expect(vault.status()).toEqual({ state: 'locked', mode: 'device' });
    vault.unlockDevice();
    expect(copyDek(vault).equals(before)).toBe(true);
  });

  it('unlockDevice throws INTERNAL when decrypt throws', async () => {
    const dir = newDir();
    newVault(dir, { deviceKey }).initialiseDevice();
    const broken = newVault(dir, {
      deviceKey: {
        ...deviceKey,
        decrypt: () => {
          throw new Error('keyring locked');
        },
      },
    });
    await expectInternal(() => broken.unlockDevice());
  });

  it('unlockDevice throws INTERNAL and zeroes the result when it is not 32 bytes', async () => {
    const dir = newDir();
    newVault(dir, { deviceKey }).initialiseDevice();
    const short = newVault(dir, {
      deviceKey: { ...deviceKey, decrypt: () => Buffer.alloc(31, 1) },
    });
    await expectInternal(() => short.unlockDevice());
  });

  it('never locks on idle in device mode, even when setIdleLockMs is called', () => {
    vi.useFakeTimers();
    let clock = 0;
    const vault = newVault(newDir(), { idleLockMs: 1000, now: () => clock, deviceKey });
    vault.initialiseDevice();
    vault.setIdleLockMs(1000);
    clock = 5000;
    vi.advanceTimersByTime(5000);
    expect(vault.status()).toEqual({ state: 'unlocked', mode: 'device' });
  });

  it('setPassword writes a version 1 keyring, keeps the live DEK, and locks on idle again', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const vault = newVault(newDir(), { idleLockMs: 1000, now: () => clock, deviceKey });
    vault.initialiseDevice();
    const before = copyDek(vault);
    vault.setPassword(OTHER_PASSWORD);
    expect(readKeyringFile(vault.keyringPath)?.version).toBe(1);
    expect(copyDek(vault).equals(before)).toBe(true);
    clock = 1000;
    vi.advanceTimersByTime(1000);
    expect(vault.status()).toEqual({ state: 'locked', mode: 'password' });
    await vault.unlock(OTHER_PASSWORD);
    expect(copyDek(vault).equals(before)).toBe(true);
    vault.lock();
  });

  it('setPassword is rejected in password mode and while locked', async () => {
    const passwordVault = newVault(newDir(), { deviceKey });
    passwordVault.initialise(PASSWORD);
    await expectCode(() => passwordVault.setPassword(OTHER_PASSWORD), 'VALIDATION');

    const deviceVault = newVault(newDir(), { deviceKey });
    deviceVault.initialiseDevice();
    deviceVault.lock();
    await expectCode(() => deviceVault.setPassword(OTHER_PASSWORD), 'VAULT_LOCKED');
  });

  it('removePassword with the right password writes version 2, and unlockDevice then works', async () => {
    const vault = newVault(newDir(), { deviceKey });
    vault.initialise(PASSWORD);
    const before = copyDek(vault);
    await vault.removePassword(PASSWORD);
    expect(readKeyringFile(vault.keyringPath)).toMatchObject({ version: 2, mode: 'device' });
    vault.lock();
    vault.unlockDevice();
    expect(copyDek(vault).equals(before)).toBe(true);
  });

  it('removePassword with a wrong password leaves the keyring unchanged', async () => {
    const vault = newVault(newDir(), { deviceKey });
    vault.initialise(PASSWORD);
    vault.lock();
    const before = readFileSync(vault.keyringPath, 'utf8');
    await expectCode(() => vault.removePassword(OTHER_PASSWORD), 'VAULT_BAD_PASSWORD');
    expect(readFileSync(vault.keyringPath, 'utf8')).toBe(before);
  });

  it('removePassword and initialiseDevice give VALIDATION when the device key is unavailable', async () => {
    const dir = newDir();
    const passwordVault = newVault(dir, { deviceKey: unavailableKey });
    passwordVault.initialise(PASSWORD);
    await expectCode(() => passwordVault.removePassword(PASSWORD), 'VALIDATION');

    const fresh = newVault(newDir(), { deviceKey: unavailableKey });
    expect(() => fresh.initialiseDevice()).toThrow(AppErrorException);
    expect(existsSync(fresh.keyringPath)).toBe(false);
  });

  it('unlock and changePassword give VALIDATION in device mode', async () => {
    const vault = newVault(newDir(), { deviceKey });
    vault.initialiseDevice();
    vault.lock();
    await expectCode(() => vault.unlock(PASSWORD), 'VALIDATION');
    await expectCode(() => vault.changePassword(PASSWORD, OTHER_PASSWORD), 'VALIDATION');
  });

  it('status reports locked password for a malformed keyring without throwing', () => {
    const vault = newVault(newDir());
    writeFileSync(vault.keyringPath, '{"version": 9}');
    expect(vault.status()).toEqual({ state: 'locked', mode: 'password' });
  });

  it('reports no-encryption when no device key is configured', () => {
    expect(newVault(newDir()).deviceKeyAvailability()).toEqual({
      available: false,
      reason: 'no-encryption',
    });
  });
});
