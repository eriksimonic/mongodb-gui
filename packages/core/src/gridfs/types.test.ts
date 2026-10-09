import { describe, expect, it } from 'vitest';
import {
  GridFsBucketNameSchema,
  GridFsDeleteInputSchema,
  GridFsDownloadInputSchema,
  GridFsListInputSchema,
  GridFsRenameInputSchema,
  GridFsUploadInputSchema,
} from './types';

const DB = 'shop';

describe('GridFsBucketNameSchema', () => {
  it.each(['fs', 'photos', 'my.bucket'])('accepts %s', (name) => {
    expect(GridFsBucketNameSchema.safeParse(name).success).toBe(true);
  });

  it.each(['', 'a$b', 'system.photos', 'photos.files', 'photos.chunks', 'bad\u0000name'])(
    'refuses %j',
    (name) => {
      expect(GridFsBucketNameSchema.safeParse(name).success).toBe(false);
    },
  );

  it('refuses names whose .files collection would exceed 255 bytes', () => {
    const name = 'é'.repeat(130);
    expect(GridFsBucketNameSchema.safeParse(name).success).toBe(false);
    expect(GridFsBucketNameSchema.safeParse('é'.repeat(100)).success).toBe(true);
  });
});

describe('GridFsListInputSchema', () => {
  it('applies the default limit and leaves the filter unset', () => {
    const parsed = GridFsListInputSchema.parse({ database: DB, bucket: 'fs' });
    expect(parsed.limit).toBe(200);
    expect(parsed.filter).toBeUndefined();
  });

  it('refuses a limit above 5000', () => {
    expect(
      GridFsListInputSchema.safeParse({ database: DB, bucket: 'fs', limit: 5001 }).success,
    ).toBe(false);
  });

  it('refuses dates that are not ISO strings', () => {
    const result = GridFsListInputSchema.safeParse({
      database: DB,
      bucket: 'fs',
      filter: { since: 'yesterday' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a filter with a date range', () => {
    const result = GridFsListInputSchema.safeParse({
      database: DB,
      bucket: 'fs',
      filter: { filenameContains: 'report', since: '2026-01-01T00:00:00Z' },
      sort: 'length',
      direction: 'desc',
    });
    expect(result.success).toBe(true);
  });
});

describe('GridFsUploadInputSchema', () => {
  it('requires an absolute path', () => {
    expect(
      GridFsUploadInputSchema.safeParse({ database: DB, bucket: 'fs', path: 'report.pdf' }).success,
    ).toBe(false);
    expect(
      GridFsUploadInputSchema.safeParse({ database: DB, bucket: 'fs', path: '/tmp/report.pdf' })
        .success,
    ).toBe(true);
  });

  it('refuses a filename with a null byte', () => {
    expect(
      GridFsUploadInputSchema.safeParse({
        database: DB,
        bucket: 'fs',
        path: '/tmp/x',
        filename: 'a\u0000b',
      }).success,
    ).toBe(false);
  });

  it('refuses chunk sizes below 1 KB or above 15 MB', () => {
    const base = { database: DB, bucket: 'fs', path: '/tmp/x' };
    expect(GridFsUploadInputSchema.safeParse({ ...base, chunkSizeBytes: 0 }).success).toBe(false);
    expect(GridFsUploadInputSchema.safeParse({ ...base, chunkSizeBytes: 1023 }).success).toBe(
      false,
    );
    expect(GridFsUploadInputSchema.safeParse({ ...base, chunkSizeBytes: 1024 }).success).toBe(true);
    expect(
      GridFsUploadInputSchema.safeParse({ ...base, chunkSizeBytes: 16 * 1024 * 1024 }).success,
    ).toBe(false);
    expect(GridFsUploadInputSchema.safeParse({ ...base, chunkSizeBytes: 261120 }).success).toBe(
      true,
    );
  });
});

describe('GridFsDownloadInputSchema', () => {
  it('accepts an absolute target and an optional overwrite flag', () => {
    const result = GridFsDownloadInputSchema.safeParse({
      database: DB,
      bucket: 'fs',
      idEjson: '{"$oid":"64b000000000000000000001"}',
      path: '/tmp/out.bin',
      overwrite: true,
    });
    expect(result.success).toBe(true);
  });

  it('refuses a relative target', () => {
    expect(
      GridFsDownloadInputSchema.safeParse({
        database: DB,
        bucket: 'fs',
        idEjson: '1',
        path: 'out.bin',
      }).success,
    ).toBe(false);
  });
});

describe('GridFsDeleteInputSchema and GridFsRenameInputSchema', () => {
  it('requires at least one id to delete', () => {
    expect(
      GridFsDeleteInputSchema.safeParse({ database: DB, bucket: 'fs', idsEjson: [] }).success,
    ).toBe(false);
  });

  it('refuses an empty filename on rename', () => {
    expect(
      GridFsRenameInputSchema.safeParse({
        database: DB,
        bucket: 'fs',
        idEjson: '1',
        filename: '',
      }).success,
    ).toBe(false);
  });
});
