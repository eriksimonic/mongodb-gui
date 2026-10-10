import { describe, expect, it } from 'vitest';
import {
  Sha256Schema,
  ToolsInstallIdSchema,
  ToolsInstallManifestSchema,
  ToolsPreferenceSchema,
  ToolsVersionSchema,
} from './types';

describe('tools schemas', () => {
  it('accepts a three part version only', () => {
    expect(ToolsVersionSchema.safeParse('100.19.1').success).toBe(true);
    expect(ToolsVersionSchema.safeParse('100.19').success).toBe(false);
    expect(ToolsVersionSchema.safeParse('100.19.1-rc').success).toBe(false);
  });

  it('accepts auto or a version as the preference', () => {
    expect(ToolsPreferenceSchema.safeParse('auto').success).toBe(true);
    expect(ToolsPreferenceSchema.safeParse('100.19.1').success).toBe(true);
    expect(ToolsPreferenceSchema.safeParse('newest').success).toBe(false);
  });

  it('accepts bundled and downloaded install ids', () => {
    expect(ToolsInstallIdSchema.safeParse('bundled').success).toBe(true);
    expect(ToolsInstallIdSchema.safeParse('downloaded:100.19.1').success).toBe(true);
    expect(ToolsInstallIdSchema.safeParse('downloaded:../x').success).toBe(false);
  });

  it('takes lowercase hex sha256 only', () => {
    expect(Sha256Schema.safeParse('0'.repeat(64)).success).toBe(true);
    expect(Sha256Schema.safeParse('A'.repeat(64)).success).toBe(false);
    expect(Sha256Schema.safeParse('0'.repeat(63)).success).toBe(false);
  });

  it('parses an install manifest', () => {
    const manifest = {
      format: 'mongo-gui.tools',
      formatVersion: 1,
      source: 'bundled',
      version: '100.19.1',
      target: 'ubuntu2204',
      os: 'linux',
      arch: 'x64',
      archiveUrl: 'https://fastdl.mongodb.org/tools/db/x.tgz',
      archiveSha256: 'a'.repeat(64),
      binaries: { mongodump: 'b'.repeat(64), mongorestore: 'c'.repeat(64) },
      installedAt: '2026-10-10T18:42:00.000Z',
    };
    expect(ToolsInstallManifestSchema.safeParse(manifest).success).toBe(true);
    expect(ToolsInstallManifestSchema.safeParse({ ...manifest, formatVersion: 2 }).success).toBe(
      false,
    );
  });
});
