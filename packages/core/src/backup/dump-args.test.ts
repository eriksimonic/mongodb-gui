import { describe, expect, it } from 'vitest';
import { toolsConfigYaml } from './config-file';
import { dumpArgs, dumpRunScopes } from './dump-args';
import { DumpOptionsSchema } from './options';
import { toolsUri } from './tools-uri';

const CONFIG = '/data/tmp/tools-1/config.yaml';

describe('dumpArgs', () => {
  it('dumps a whole server to stdout with the defaults', () => {
    expect(
      dumpArgs({
        configPath: CONFIG,
        scope: { kind: 'server' },
        options: DumpOptionsSchema.parse({}),
      }),
    ).toEqual([`--config=${CONFIG}`, '--gzip', '--numParallelCollections=4', '--archive']);
  });

  it('passes every flag in order with the --flag=value form', () => {
    const options = DumpOptionsSchema.parse({
      output: 'directory',
      query: '{"total":{"$gt":5}}',
      excludeCollections: ['logs', '-tmp'],
      excludeCollectionsWithPrefix: ['cache_'],
      oplog: true,
      dumpDbUsersAndRoles: true,
      viewsAsCollections: true,
      forceTableScan: true,
      numParallelCollections: 2,
      compressors: ['zstd', 'snappy'],
    });
    expect(
      dumpArgs({
        configPath: CONFIG,
        scope: { kind: 'collection', database: 'shop', collection: 'orders' },
        options,
        outDir: '/backups/my dump',
      }),
    ).toEqual([
      `--config=${CONFIG}`,
      '--db=shop',
      '--collection=orders',
      '--query={"total":{"$gt":5}}',
      '--excludeCollection=logs',
      '--excludeCollection=-tmp',
      '--excludeCollectionsWithPrefix=cache_',
      '--oplog',
      '--dumpDbUsersAndRoles',
      '--viewsAsCollections',
      '--forceTableScan',
      '--gzip',
      '--numParallelCollections=2',
      '--compressors=zstd,snappy',
      '--out=/backups/my dump',
    ]);
  });

  it('passes a database scope without a collection', () => {
    const args = dumpArgs({
      configPath: CONFIG,
      scope: { kind: 'database', database: 'shop' },
      options: DumpOptionsSchema.parse({ gzip: false }),
    });
    expect(args).toEqual([
      `--config=${CONFIG}`,
      '--db=shop',
      '--numParallelCollections=4',
      '--archive',
    ]);
  });

  it('refuses a directory dump without an output folder', () => {
    expect(() =>
      dumpArgs({
        configPath: CONFIG,
        scope: { kind: 'server' },
        options: DumpOptionsSchema.parse({ output: 'directory' }),
      }),
    ).toThrow('output folder');
  });

  it('keeps hosts and credentials out of the argv', () => {
    const uri = toolsUri({
      uri: 'mongodb://admin:hunter2@db1.example.com:27017,db2.example.com:27018/shop?replicaSet=rs0',
    });
    expect(toolsConfigYaml(uri)).toContain('hunter2');
    const args = dumpArgs({
      configPath: CONFIG,
      scope: { kind: 'database', database: 'shop' },
      options: DumpOptionsSchema.parse({}),
    });
    const argv = args.join(' ');
    for (const secret of ['hunter2', 'admin:', 'db1.example.com', 'db2.example.com', 'rs0']) {
      expect(argv).not.toContain(secret);
    }
  });
});

describe('dumpRunScopes', () => {
  it('splits several databases into one run each', () => {
    expect(dumpRunScopes({ kind: 'databases', databases: ['shop', 'blog'] })).toEqual([
      { kind: 'database', database: 'shop' },
      { kind: 'database', database: 'blog' },
    ]);
  });

  it('keeps any other scope as one run', () => {
    expect(dumpRunScopes({ kind: 'server' })).toEqual([{ kind: 'server' }]);
  });
});
