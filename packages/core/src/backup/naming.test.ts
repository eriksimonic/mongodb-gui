import { describe, expect, it } from 'vitest';
import { backupFileName, defaultBackupName, detectArchiveKind, sidecarPathFor } from './naming';
import { BackupNameSchema } from './options';

const now = new Date(2026, 9, 10, 18, 42, 7);

describe('defaultBackupName', () => {
  it('names a server backup', () => {
    expect(defaultBackupName('Local', { kind: 'server' }, now)).toBe('Local-all-20261010-184207');
  });

  it('names database and collection backups', () => {
    expect(defaultBackupName('Local', { kind: 'database', database: 'shop' }, now)).toBe(
      'Local-shop-20261010-184207',
    );
    expect(
      defaultBackupName(
        'Local',
        { kind: 'collection', database: 'shop', collection: 'orders' },
        now,
      ),
    ).toBe('Local-shop-orders-20261010-184207');
  });

  it('names a several-database backup', () => {
    expect(defaultBackupName('Local', { kind: 'databases', databases: ['a', 'b'] }, now)).toBe(
      'Local-2-databases-20261010-184207',
    );
  });

  it('sanitises and always passes the name schema', () => {
    const name = defaultBackupName('a/b:c*?', { kind: 'server' }, now);
    expect(name).toBe('a-b-c-all-20261010-184207');
    const long = defaultBackupName('x'.repeat(400), { kind: 'server' }, now);
    expect(BackupNameSchema.safeParse(long).success).toBe(true);
    expect(
      BackupNameSchema.safeParse(defaultBackupName('...', { kind: 'server' }, now)).success,
    ).toBe(true);
  });
});

describe('backupFileName', () => {
  it('adds the archive suffixes', () => {
    expect(backupFileName('a', { output: 'archive', gzip: true })).toBe('a.archive.gz');
    expect(backupFileName('a', { output: 'archive', gzip: false })).toBe('a.archive');
    expect(backupFileName('a', { output: 'directory', gzip: true })).toBe('a');
  });
});

describe('sidecarPathFor', () => {
  it('places the sidecar', () => {
    expect(sidecarPathFor('/b/a.archive.gz', 'archive')).toBe('/b/a.archive.gz.json');
    expect(sidecarPathFor('/b/a', 'directory')).toBe('/b/a/mongo-gui-backup.json');
    expect(sidecarPathFor('C:\\b\\a', 'directory')).toBe('C:\\b\\a\\mongo-gui-backup.json');
  });
});

describe('detectArchiveKind', () => {
  it('reads the magic bytes', () => {
    expect(detectArchiveKind(Uint8Array.from([0x1f, 0x8b, 8, 0]))).toBe('gzip');
    expect(detectArchiveKind(Uint8Array.from([0x6d, 0xe2, 0x99, 0x81]))).toBe('archive');
    expect(detectArchiveKind(Uint8Array.from([1, 2, 3, 4]))).toBe('unknown');
    expect(detectArchiveKind(new Uint8Array())).toBe('unknown');
  });
});
