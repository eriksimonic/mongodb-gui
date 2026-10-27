import { describe, expect, it, vi } from 'vitest';
import { createSafeStorageDeviceKey } from './device-key';

type Backend = 'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown';

function fakeSafeStorage(options: { available?: boolean; backend?: Backend } = {}) {
  return {
    isEncryptionAvailable: vi.fn(() => options.available ?? true),
    getSelectedStorageBackend: vi.fn((): Backend => options.backend ?? 'gnome_libsecret'),
    encryptString: vi.fn((text: string) => Buffer.from(`enc:${text}`, 'utf8')),
    decryptString: vi.fn((buf: Buffer) => buf.toString('utf8').replace(/^enc:/, '')),
  };
}

describe('createSafeStorageDeviceKey availability', () => {
  it('is available on win32', () => {
    const provider = createSafeStorageDeviceKey(fakeSafeStorage(), 'win32');
    expect(provider.availability()).toEqual({ available: true });
  });

  it('reports no-encryption on win32 when safeStorage is unavailable', () => {
    const provider = createSafeStorageDeviceKey(fakeSafeStorage({ available: false }), 'win32');
    expect(provider.availability()).toEqual({ available: false, reason: 'no-encryption' });
  });

  it('reports basic-text on linux', () => {
    const storage = fakeSafeStorage({ backend: 'basic_text' });
    const provider = createSafeStorageDeviceKey(storage, 'linux');
    expect(provider.availability()).toEqual({ available: false, reason: 'basic-text' });
  });

  it('reports unknown-backend on linux', () => {
    const storage = fakeSafeStorage({ backend: 'unknown' });
    const provider = createSafeStorageDeviceKey(storage, 'linux');
    expect(provider.availability()).toEqual({ available: false, reason: 'unknown-backend' });
  });

  it('is available on linux with gnome_libsecret', () => {
    const storage = fakeSafeStorage({ backend: 'gnome_libsecret' });
    const provider = createSafeStorageDeviceKey(storage, 'linux');
    expect(provider.availability()).toEqual({ available: true });
  });

  it('does not query the backend on darwin or win32', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const storage = fakeSafeStorage({ backend: 'basic_text' });
      createSafeStorageDeviceKey(storage, platform).availability();
      expect(storage.getSelectedStorageBackend).not.toHaveBeenCalled();
    }
  });
});

describe('createSafeStorageDeviceKey encrypt and decrypt', () => {
  it('round-trips 32 bytes', () => {
    const provider = createSafeStorageDeviceKey(fakeSafeStorage(), 'win32');
    const dek = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    const wrapped = provider.encrypt(dek);
    expect(provider.decrypt(wrapped)).toEqual(dek);
  });
});
