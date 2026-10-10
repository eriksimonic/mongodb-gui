import type { ConnectionProfile } from '@mongo-gui/core';
import { fail } from './mock-support';

/**
 * The passphrase of the sample file. An import of a path the mock export did not write opens the
 * sample profiles, and only this passphrase opens them. The dev UI and the tests type it to see
 * the sample. Any other passphrase gets the wrong-passphrase refusal, as a real file would.
 */
export const MOCK_SAMPLE_PASSPHRASE = 'sample passphrase';

/** The extension of connection files, as the settings dialogs filter them. */
export const CONNECTIONS_EXTENSION = 'mgconn';

/**
 * Connection files the mock export wrote, keyed by the picked path. The mock has no disk, so the
 * files live in memory for the life of one mock api.
 */
export interface MockConnectionFiles {
  save(path: string, passphrase: string, profiles: readonly ConnectionProfile[]): void;
  /** The path of the last export, or undefined when none happened. */
  lastPath(): string | undefined;
  read(path: string, passphrase: string): ConnectionProfile[];
}

/** The profiles of the sample file. "Staging" collides with a fixture connection. */
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
  let last: string | undefined;
  return {
    save(path, passphrase, profiles) {
      files.set(path, { passphrase, profiles: [...profiles] });
      last = path;
    },
    lastPath() {
      return last;
    },
    read(path, passphrase) {
      const written = files.get(path);
      if (written === undefined) {
        if (passphrase !== MOCK_SAMPLE_PASSPHRASE) {
          throw fail('VALIDATION', 'Wrong passphrase or damaged file.');
        }
        return [...MOCK_IMPORT_PROFILES];
      }
      if (written.passphrase !== passphrase) {
        throw fail('VALIDATION', 'Wrong passphrase or damaged file.');
      }
      return [...written.profiles];
    },
  };
}
