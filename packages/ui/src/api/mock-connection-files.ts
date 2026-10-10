import type { ConnectionProfile } from '@mongo-gui/core';
import { fail } from './mock-support';

/**
 * Connection files the mock export wrote, keyed by the picked path. The mock has no disk, so an
 * import of a path it did not write reads the sample profiles below under any passphrase.
 */
export interface MockConnectionFiles {
  save(path: string, passphrase: string, profiles: readonly ConnectionProfile[]): void;
  read(path: string, passphrase: string): ConnectionProfile[];
}

/** The profiles an unknown file holds. "Staging" collides with a fixture connection. */
export const MOCK_IMPORT_PROFILES: readonly ConnectionProfile[] = [
  {
    id: '5c0d7e21-8f3a-4b6c-9d2e-1a7b4c8f0e35',
    name: 'Staging',
    uri: 'mongodb://app:staging-secret@staging.example.com:27017/shop?authSource=admin',
    createdAt: '2026-03-01T09:00:00.000Z',
    updatedAt: '2026-03-01T09:00:00.000Z',
  },
  {
    id: '9e4a1b6c-2d7f-4e8a-8b3c-6f5d4e3a2b1c',
    name: 'Reporting',
    uri: 'mongodb://reporting.example.com:27017/?tls=true',
    tls: { enabled: true },
    createdAt: '2026-03-02T09:00:00.000Z',
    updatedAt: '2026-03-02T09:00:00.000Z',
  },
];

export function createMockConnectionFiles(): MockConnectionFiles {
  const files = new Map<string, { passphrase: string; profiles: ConnectionProfile[] }>();
  return {
    save(path, passphrase, profiles) {
      files.set(path, { passphrase, profiles: [...profiles] });
    },
    read(path, passphrase) {
      const written = files.get(path);
      if (written === undefined) {
        return [...MOCK_IMPORT_PROFILES];
      }
      if (written.passphrase !== passphrase) {
        throw fail('VALIDATION', 'Wrong passphrase or damaged file.');
      }
      return [...written.profiles];
    },
  };
}
