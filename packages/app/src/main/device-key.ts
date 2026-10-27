import type { DeviceKeyAvailability } from '@mongo-gui/core';
import type { DeviceKeyProvider } from '@mongo-gui/storage';

type SafeStorageLike = Pick<
  Electron.SafeStorage,
  'isEncryptionAvailable' | 'getSelectedStorageBackend' | 'encryptString' | 'decryptString'
>;

/**
 * Wraps the data key with the OS key store through Electron safeStorage. On Linux the key store
 * can be missing or a plain-text backend, and the availability check reports that.
 */
export function createSafeStorageDeviceKey(
  safeStorage: SafeStorageLike,
  platform: NodeJS.Platform,
): DeviceKeyProvider {
  const availability = (): DeviceKeyAvailability => {
    if (!safeStorage.isEncryptionAvailable()) {
      return { available: false, reason: 'no-encryption' };
    }
    if (platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend();
      if (backend === 'basic_text') {
        return { available: false, reason: 'basic-text' };
      }
      if (backend === 'unknown') {
        return { available: false, reason: 'unknown-backend' };
      }
    }
    return { available: true };
  };
  return {
    availability,
    encrypt: (dek) => safeStorage.encryptString(dek.toString('base64')),
    decrypt: (wrapped) => Buffer.from(safeStorage.decryptString(wrapped), 'base64'),
  };
}
