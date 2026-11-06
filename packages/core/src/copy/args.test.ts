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
        timeseries: false,
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
      copyRestoreArgs({
        configPath: CONFIG,
        source: ns,
        target: ns,
        mode: 'insertOnly',
        timeseries: false,
      }),
    ).toEqual([`--config=${CONFIG}`, '--archive', '--noIndexRestore', ...TAIL]);
  });

  it('a time series source adds the bucket pair after the collection pair', () => {
    expect(
      copyRestoreArgs({
        configPath: CONFIG,
        source: { database: 'shop', collection: 'metrics' },
        target: { database: 'shopcopy', collection: 'metrics' },
        mode: 'replace',
        timeseries: true,
      }),
    ).toEqual([
      `--config=${CONFIG}`,
      '--archive',
      '--drop',
      ...TAIL,
      '--nsFrom=shop.metrics',
      '--nsTo=shopcopy.metrics',
      '--nsFrom=shop.system.buckets.metrics',
      '--nsTo=shopcopy.system.buckets.metrics',
    ]);
  });

  it('a time series source in insert only maps its buckets too, and a plain source does not', () => {
    const source = { database: 'shop', collection: 'metrics' };
    const target = { database: 'shopcopy', collection: 'metrics2' };
    const timeseries = copyRestoreArgs({
      configPath: CONFIG,
      source,
      target,
      mode: 'insertOnly',
      timeseries: true,
    });
    expect(timeseries.slice(-4)).toEqual([
      '--nsFrom=shop.metrics',
      '--nsTo=shopcopy.metrics2',
      '--nsFrom=shop.system.buckets.metrics',
      '--nsTo=shopcopy.system.buckets.metrics2',
    ]);
    const plain = copyRestoreArgs({
      configPath: CONFIG,
      source,
      target,
      mode: 'insertOnly',
      timeseries: false,
    });
    expect(plain.filter((arg) => arg.includes('system.buckets'))).toEqual([]);
    expect(plain.slice(-2)).toEqual(['--nsFrom=shop.metrics', '--nsTo=shopcopy.metrics2']);
  });
});
