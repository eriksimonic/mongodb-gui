import { describe, expect, it } from 'vitest';
import { copyDumpArgs, copyRestoreArgs } from './args';

const CONFIG = '/data/tmp/tools-1/config.yaml';
const TAIL = ['--numParallelCollections=4', '--numInsertionWorkersPerCollection=1'];

describe('copyDumpArgs', () => {
  it('dumps one collection to stdout without gzip', () => {
    expect(
      copyDumpArgs({ configPath: CONFIG, source: { database: 'shop', collection: 'orders' } }),
    ).toEqual([
      `--config=${CONFIG}`,
      '--db=shop',
      '--collection=orders',
      '--numParallelCollections=4',
      '--archive',
    ]);
  });

  it('passes a filter with quotes as one argument', () => {
    const filter = '{"name": "it\'s \\"x\\""}';
    const args = copyDumpArgs({
      configPath: CONFIG,
      source: { database: 'shop', collection: 'orders' },
      filter,
    });
    expect(args).toContain(`--query=${filter}`);
    expect(args.filter((arg) => arg.startsWith('--query'))).toHaveLength(1);
  });
});

describe('copyRestoreArgs', () => {
  it('replace drops the target and renames to the target name', () => {
    expect(
      copyRestoreArgs({
        configPath: CONFIG,
        source: { database: 'shop', collection: 'orders' },
        target: { database: 'shop', collection: '__copy_x_orders' },
        mode: 'replace',
      }),
    ).toEqual([
      `--config=${CONFIG}`,
      '--archive',
      '--drop',
      ...TAIL,
      '--nsFrom=shop.orders',
      '--nsTo=shop.__copy_x_orders',
    ]);
  });

  it('insert only skips the index restore and writes the same name without renames', () => {
    const ns = { database: 'shop_copy', collection: 'orders' };
    expect(
      copyRestoreArgs({ configPath: CONFIG, source: ns, target: ns, mode: 'insertOnly' }),
    ).toEqual([`--config=${CONFIG}`, '--archive', '--noIndexRestore', ...TAIL]);
  });
});
