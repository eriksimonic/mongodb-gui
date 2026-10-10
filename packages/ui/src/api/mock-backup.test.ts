import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DumpOptionsSchema, RestoreOptionsSchema, type RpcEvent } from '@mongo-gui/core';
import { createMockBackup } from './mock-backup';
import { fixtureCatalog } from './mock-catalog';
import { createMockPicks } from './mock-picks';
import { localConnectionId } from './mock-fixtures';

const FOLDER = '/mock/backups';

function setup() {
  const events: RpcEvent[] = [];
  const picks = createMockPicks();
  picks.folder(FOLDER);
  picks.opened('/mock/shop.archive.gz');
  const catalog = fixtureCatalog(localConnectionId);
  const backup = createMockBackup({
    emit: (event) => events.push(event),
    picks,
    catalogOf: () => catalog,
    statusOf: () => ({
      state: 'connected',
      serverVersion: '8.0.4',
      topology: 'standalone',
      hosts: ['localhost:27017'],
    }),
  });
  return { backup, events };
}

function dumpInput(
  scope: Parameters<ReturnType<typeof setup>['backup']['start']>[0]['scope'],
  output: 'archive' | 'directory' = 'archive',
) {
  return {
    connectionId: localConnectionId,
    scope,
    options: DumpOptionsSchema.parse({ output }),
    folder: FOLDER,
    name: 'shop-backup',
    toolsVersion: '100.19.1',
    acknowledged: [],
  };
}

function progressOf(events: readonly RpcEvent[]) {
  return events.flatMap((event) => (event.type === 'backup:progress' ? [event] : []));
}

describe('mock backup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('describes the server and the namespaces of a database scope', () => {
    const { backup } = setup();
    const info = backup.describeServer(localConnectionId, { kind: 'database', database: 'shop' });
    expect(info.serverVersion).toBe('8.0.4');
    expect(info.databases).toContain('shop');
    expect(info.namespaces.map((item) => item.collection)).toEqual(
      expect.arrayContaining(['orders', 'customers', 'paid_orders', 'sensor_readings']),
    );
    expect(info.namespaces.find((item) => item.collection === 'paid_orders')?.type).toBe('view');
  });

  it('dumps with real-looking lines and ends with a result', async () => {
    const { backup, events } = setup();
    const jobId = backup.start(dumpInput({ kind: 'database', database: 'shop' }));
    await vi.advanceTimersByTimeAsync(5000);

    const all = progressOf(events);
    expect(all.every((event) => event.jobId === jobId && event.kind === 'dump')).toBe(true);
    const lines = all.flatMap((event) => event.progress.lines);
    expect(
      lines.some((line) => line.includes('writing `shop.orders` to `archive on stdout`')),
    ).toBe(true);
    expect(lines.some((line) => /\[#+\.*\]\s+shop\.orders/.test(line))).toBe(true);
    expect(lines.some((line) => line.includes('done dumping `shop.orders`'))).toBe(true);
    const last = all.at(-1)?.progress;
    expect(last?.done).toBe(true);
    expect(last?.result).toMatchObject({
      kind: 'dump',
      outputPath: `${FOLDER}/shop-backup.archive.gz`,
      sidecarPath: `${FOLDER}/shop-backup.archive.gz.json`,
    });
    expect(backup.wroteFile(`${FOLDER}/shop-backup.archive.gz`)).toBe(true);
  });

  it('reports the current database for a several-database dump', async () => {
    const { backup, events } = setup();
    backup.start(dumpInput({ kind: 'databases', databases: ['shop', 'analytics'] }, 'directory'));
    await vi.advanceTimersByTimeAsync(8000);

    const seen = progressOf(events).flatMap((event) =>
      event.progress.currentDatabase === undefined
        ? []
        : [
            `${event.progress.databaseIndex}/${event.progress.databaseCount} ${event.progress.currentDatabase}`,
          ],
    );
    expect(seen).toContain('1/2 shop');
    expect(seen).toContain('2/2 analytics');
    expect(progressOf(events).at(-1)?.progress.result).toMatchObject({
      outputPath: `${FOLDER}/shop-backup`,
      sidecarPath: `${FOLDER}/shop-backup/mongo-gui-backup.json`,
    });
  });

  it('refuses a folder the dialog did not return', () => {
    const { backup } = setup();
    expect(() =>
      backup.start({ ...dumpInput({ kind: 'server' }), folder: '/elsewhere' }),
    ).toThrow();
  });

  it('cancels a dump, ends with a cancelled frame and writes nothing', async () => {
    const { backup, events } = setup();
    const jobId = backup.start(dumpInput({ kind: 'server' }));
    await vi.advanceTimersByTimeAsync(200);
    backup.cancel(jobId);
    const count = progressOf(events).length;
    await vi.advanceTimersByTimeAsync(8000);

    const all = progressOf(events);
    expect(all).toHaveLength(count);
    expect(all.at(-1)?.progress).toMatchObject({ done: true, cancelled: true });
    expect(all.at(-1)?.progress.result).toBeUndefined();
    expect(backup.wroteFile(`${FOLDER}/shop-backup.archive.gz`)).toBe(false);
  });

  it('inspects a picked archive and a picked folder with the fixture sidecar', () => {
    const { backup } = setup();
    const archive = backup.inspect('/mock/shop.archive.gz');
    expect(archive.kind).toBe('archive');
    expect(archive.sidecar?.tools.version).toBe('100.12.1');
    expect(archive.sidecar?.source.serverVersion).toBe('7.0.14');
    expect(archive.namespaces.map((item) => item.type)).toEqual([
      'collection',
      'collection',
      'view',
      'timeseries',
    ]);
    expect(backup.inspect(FOLDER).kind).toBe('directory');
    expect(() => backup.inspect('/mock/unpicked.archive')).toThrow();
  });

  it('restores with a rename, reports a summary and announces the catalog change', async () => {
    const { backup, events } = setup();
    const inspection = backup.inspect('/mock/shop.archive.gz');
    backup.startRestore({
      connectionId: localConnectionId,
      source: inspection.path,
      toolsVersion: '100.19.1',
      options: RestoreOptionsSchema.parse({ renames: [{ from: 'shop', to: 'shop_copy' }] }),
      acknowledged: [],
    });
    await vi.advanceTimersByTimeAsync(8000);

    const result = progressOf(events).at(-1)?.progress.result;
    expect(result).toMatchObject({
      kind: 'restore',
      dryRun: false,
      failed: 0,
      databases: ['shop_copy'],
    });
    expect(events).toContainEqual({
      type: 'catalog:changed',
      connectionId: localConnectionId,
      database: 'shop_copy',
    });
  });

  it('plans a dry run without changing the catalog', async () => {
    const { backup, events } = setup();
    const inspection = backup.inspect('/mock/shop.archive.gz');
    backup.startRestore({
      connectionId: localConnectionId,
      source: inspection.path,
      toolsVersion: '100.19.1',
      options: RestoreOptionsSchema.parse({ dryRun: true, include: ['shop.orders'] }),
      acknowledged: [],
    });
    await vi.advanceTimersByTimeAsync(8000);

    const result = progressOf(events).at(-1)?.progress.result;
    expect(result).toMatchObject({
      kind: 'restore',
      dryRun: true,
      plan: [{ from: 'shop.orders', to: 'shop.orders' }],
    });
    expect(events.some((event) => event.type === 'catalog:changed')).toBe(false);
  });

  it('refuses to restore a source that was not inspected', () => {
    const { backup } = setup();
    expect(() =>
      backup.startRestore({
        connectionId: localConnectionId,
        source: '/mock/other.archive',
        toolsVersion: '100.19.1',
        options: RestoreOptionsSchema.parse({}),
        acknowledged: [],
      }),
    ).toThrow();
  });
});
