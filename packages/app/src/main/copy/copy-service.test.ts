import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppErrorException,
  appError,
  tempCollectionName,
  type BackupServerInfo,
  type ConnectionProfile,
  type CopyOptions,
  type CopyProgress,
  type RpcEvent,
  type ToolsInstall,
} from '@mongo-gui/core';
import type { ToolsEndpoint } from '../backup/endpoint';
import { createLogger } from '../log';
import type { ResolvedTools } from '../tools/registry';
import { createCopyService, type CopyServiceDeps } from './copy-service';

const SOURCE_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const TARGET_ID = '7a1d2e3f-4b5c-4d6e-8f70-123456789abc';
const PASSWORD = 'Sup3r-Secret';
const VERSION = '100.19.1';

type Client = ReturnType<CopyServiceDeps['getClient']>;
type RunToolOptions = Parameters<CopyServiceDeps['runTool']>[0];

interface Fixture {
  readonly sourceHost: string;
  readonly targetHost: string;
  readonly sourceNamespaces: BackupServerInfo['namespaces'];
  readonly targetNamespaces: BackupServerInfo['namespaces'];
  readonly production: boolean;
  readonly restoreLine: string;
  readonly restoreFails: boolean;
  readonly runsUntilAborted: boolean;
  /** Replaces the fake tool run. */
  readonly runToolImpl?: (options: RunToolOptions) => Promise<unknown>;
  /** The clock the service reads. Without it the real clock is used. */
  readonly clock?: { now: number };
}

let root: string;
let tmpRoot: string;

const DEFAULT: Fixture = {
  sourceHost: 'db1:27017',
  targetHost: 'db2:27017',
  sourceNamespaces: [{ database: 'shop', collection: 'orders', type: 'collection', documents: 2 }],
  targetNamespaces: [],
  production: false,
  restoreLine: '2 document(s) restored successfully. 0 document(s) failed to restore.',
  restoreFails: false,
  runsUntilAborted: false,
};

function fakeClient(host: string): Client {
  return {
    host,
    db: (database: string) => ({
      collection: (collection: string) => ({ database, collection }),
    }),
  } as unknown as Client;
}

function endpointFor(host: string, profileName: string): ToolsEndpoint {
  return {
    uri: `mongodb://app:${PASSWORD}@${host}/`,
    profileName,
    readPreference: 'primary',
    secrets: [PASSWORD],
    status: { state: 'connected' } as ToolsEndpoint['status'],
  };
}

function serverInfo(host: string, namespaces: BackupServerInfo['namespaces']): BackupServerInfo {
  return {
    serverVersion: '8.0.4',
    topology: 'standalone',
    directConnection: true,
    hosts: [host],
    databases: ['shop', 'archive'],
    namespaces,
    namespacesTruncated: false,
  };
}

function succeeded(options: RunToolOptions, restoreLine: string) {
  if (options.binary.endsWith('mongorestore')) {
    options.onLine({ kind: 'other', text: restoreLine }, restoreLine);
  }
  return Promise.resolve({ exitCode: 0, signal: null, tail: [] });
}

/** A tool run that stops only when its signal aborts, as a cancelled run does. */
function stoppedByCancel(options: RunToolOptions) {
  return new Promise<never>((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => {
      reject(new AppErrorException(appError('CANCELLED', 'The mongodump run was cancelled.')));
    });
  });
}

function harness(fixture: Partial<Fixture> = {}) {
  const f: Fixture = { ...DEFAULT, ...fixture };
  const events: RpcEvent[] = [];
  const install: ToolsInstall = {
    id: 'bundled',
    source: 'bundled',
    version: VERSION,
    target: 'ubuntu2004',
    location: root,
    sizeBytes: 1,
    health: { state: 'ok' },
    inUse: false,
  };
  const tools: ResolvedTools = {
    install,
    dir: root,
    mongodump: join(root, 'mongodump'),
    mongorestore: join(root, 'mongorestore'),
  };
  const release = vi.fn();
  const registry = {
    list: vi.fn(async () => ({ installs: [install] })),
    resolve: vi.fn(async () => tools),
    resolvePreferred: vi.fn(async () => tools),
    markInUse: vi.fn(() => release),
  } as unknown as CopyServiceDeps['registry'];
  const sourceClient = fakeClient(f.sourceHost);
  const targetClient = fakeClient(f.targetHost);
  const profiles: Record<string, ConnectionProfile> = {
    [SOURCE_ID]: { id: SOURCE_ID, name: 'Source' } as unknown as ConnectionProfile,
    [TARGET_ID]: {
      id: TARGET_ID,
      name: 'Target',
      production: f.production,
    } as unknown as ConnectionProfile,
  };
  const runTool = vi.fn(async (options: RunToolOptions) => {
    if (f.runToolImpl) return f.runToolImpl(options);
    if (f.runsUntilAborted) return stoppedByCancel(options);
    if (f.restoreFails && options.binary.endsWith('mongorestore')) {
      throw new AppErrorException(
        appError('COMMAND_FAILED', 'mongorestore failed with exit code 1.'),
      );
    }
    return succeeded(options, f.restoreLine);
  });
  const rename = vi.fn(async () => undefined);
  const dropIfExists = vi.fn(async () => undefined);
  const merge = vi.fn(async (options: { onProgress?: (counts: unknown) => void }) => {
    options.onProgress?.({ written: 2, failed: 0 });
    return { written: 2, failed: 0 };
  });
  const service = createCopyService({
    registry,
    getClient: (id) => (id === SOURCE_ID ? sourceClient : targetClient),
    getProfile: (id) => profiles[id] ?? (profiles[SOURCE_ID] as ConnectionProfile),
    endpoint: async (id) =>
      id === SOURCE_ID ? endpointFor(f.sourceHost, 'Source') : endpointFor(f.targetHost, 'Target'),
    readServerInfo: vi.fn(async (client: Client) =>
      client === sourceClient
        ? serverInfo(f.sourceHost, f.sourceNamespaces)
        : serverInfo(f.targetHost, f.targetNamespaces),
    ) as unknown as CopyServiceDeps['readServerInfo'],
    identify: vi.fn(async (client: Client) => ({
      hosts: [(client as unknown as { host: string }).host],
      setName: undefined,
    })) as unknown as CopyServiceDeps['identify'],
    rename: rename as unknown as CopyServiceDeps['rename'],
    dropIfExists: dropIfExists as unknown as CopyServiceDeps['dropIfExists'],
    merge: merge as unknown as CopyServiceDeps['merge'],
    runTool: runTool as unknown as CopyServiceDeps['runTool'],
    spawn: vi.fn() as unknown as CopyServiceDeps['spawn'],
    emit: (event) => events.push(event),
    now: () => f.clock?.now ?? Date.now(),
    tmpRoot,
    platform: 'linux',
    env: {},
    log: createLogger(() => undefined),
  });
  return { service, events, runTool, rename, dropIfExists, merge, release, registry };
}

function options(overrides: Partial<CopyOptions> = {}): CopyOptions {
  return {
    sourceConnectionId: SOURCE_ID,
    targetConnectionId: TARGET_ID,
    sourceDatabase: 'shop',
    targetDatabase: 'archive',
    items: [{ source: 'orders', target: 'orders' }],
    mode: 'replace',
    acknowledged: [],
    ...overrides,
  };
}

function finalProgress(events: RpcEvent[]): CopyProgress | undefined {
  for (const event of events) {
    if (event.type === 'copy:progress' && event.progress.done) return event.progress;
  }
  return undefined;
}

async function waitForFinal(events: RpcEvent[]): Promise<CopyProgress> {
  await vi.waitFor(() => {
    expect(finalProgress(events)).toBeDefined();
  });
  const final = finalProgress(events);
  if (final === undefined) throw new Error('The job sent no final event');
  return final;
}

function leftoverConfigs(): string[] {
  return readdirSync(tmpRoot).filter((name) => name.startsWith('tools-'));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'copy-service-'));
  tmpRoot = join(root, 'tmp');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('copy service: replace', () => {
  it('restores into a temporary collection and renames it over the target', async () => {
    const h = harness();
    const jobId = await h.service.start(options());
    const final = await waitForFinal(h.events);

    const temp = tempCollectionName('archive', 'orders', jobId);
    const [dump, restore] = h.runTool.mock.calls.map((call) => call[0]);
    expect(dump?.binary).toBe(join(root, 'mongodump'));
    expect(restore?.binary).toBe(join(root, 'mongorestore'));
    expect(restore?.args).toContain('--drop');
    expect(restore?.args).toContain(`--nsTo=archive.${temp}`);
    expect(h.rename).toHaveBeenCalledWith(expect.anything(), {
      database: 'archive',
      name: temp,
      newName: 'orders',
      dropTarget: true,
    });
    expect(h.dropIfExists).not.toHaveBeenCalled();
    expect(final).toMatchObject({ done: true, cancelled: false, documents: 2, collectionsDone: 1 });
    expect(final.error).toBeUndefined();
  });

  it('keeps the password out of the argv of both tools', async () => {
    const h = harness();
    await h.service.start(options());
    await waitForFinal(h.events);

    for (const call of h.runTool.mock.calls) {
      expect(call[0].args.join(' ')).not.toContain(PASSWORD);
    }
  });

  it('removes the config folders and reports the target database as changed', async () => {
    const h = harness();
    await h.service.start(options());
    await waitForFinal(h.events);

    expect(leftoverConfigs()).toEqual([]);
    expect(h.release).toHaveBeenCalled();
    expect(h.events).toContainEqual({
      type: 'catalog:changed',
      connectionId: TARGET_ID,
      database: 'archive',
    });
  });

  it('drops the temporary collection and keeps the target when restore fails', async () => {
    const h = harness({ restoreFails: true });
    const jobId = await h.service.start(options());
    const final = await waitForFinal(h.events);

    const temp = tempCollectionName('archive', 'orders', jobId);
    expect(h.rename).not.toHaveBeenCalled();
    expect(h.dropIfExists).toHaveBeenCalledWith(expect.anything(), {
      db: 'archive',
      collection: temp,
    });
    expect(final.error?.code).toBe('COMMAND_FAILED');
    expect(final.cancelled).toBe(false);
    expect(leftoverConfigs()).toEqual([]);
  });

  it('cancel kills both processes and drops the temporary collection', async () => {
    const h = harness({ runsUntilAborted: true });
    const jobId = await h.service.start(options());
    await vi.waitFor(() => {
      expect(h.runTool).toHaveBeenCalledTimes(2);
    });

    h.service.cancel(jobId);
    const final = await waitForFinal(h.events);

    const temp = tempCollectionName('archive', 'orders', jobId);
    for (const call of h.runTool.mock.calls) {
      expect(call[0].signal?.aborted).toBe(true);
    }
    expect(h.rename).not.toHaveBeenCalled();
    expect(h.dropIfExists).toHaveBeenCalledWith(expect.anything(), {
      db: 'archive',
      collection: temp,
    });
    expect(final).toMatchObject({ cancelled: true });
    expect(final.error?.code).toBe('CANCELLED');
    expect(leftoverConfigs()).toEqual([]);
  });

  it('cancelAll stops every running job', async () => {
    const h = harness({ runsUntilAborted: true });
    await h.service.start(options());
    await vi.waitFor(() => {
      expect(h.runTool).toHaveBeenCalledTimes(2);
    });

    h.service.cancelAll();
    const final = await waitForFinal(h.events);

    expect(final.cancelled).toBe(true);
  });

  it('writes a time series target in place with --drop and notes it', async () => {
    const h = harness({
      targetNamespaces: [{ database: 'archive', collection: 'orders', type: 'timeseries' }],
    });
    await h.service.start(options());
    const final = await waitForFinal(h.events);

    const restore = h.runTool.mock.calls[1]?.[0];
    expect(restore?.args).toContain('--drop');
    expect(restore?.args.join(' ')).not.toContain('__copy_');
    expect(h.rename).not.toHaveBeenCalled();
    expect(final.notes).toHaveLength(1);
    expect(final.notes?.[0]).toContain('time series');
  });
});

describe('copy service: insert only', () => {
  it('restores without indexes and counts the skipped documents', async () => {
    const h = harness({
      restoreLine: '0 document(s) restored successfully. 2 document(s) failed to restore.',
    });
    await h.service.start(options({ mode: 'insertOnly' }));
    const final = await waitForFinal(h.events);

    const restore = h.runTool.mock.calls[1]?.[0];
    expect(restore?.args).toContain('--noIndexRestore');
    expect(restore?.args).not.toContain('--drop');
    expect(restore?.args).toContain('--nsTo=archive.orders');
    expect(h.rename).not.toHaveBeenCalled();
    expect(final).toMatchObject({ skippedDocuments: 2, failedDocuments: 0, documents: 0 });
  });
});

describe('copy service: merge', () => {
  it('copies through the driver and never runs the tools', async () => {
    const h = harness();
    await h.service.start(
      options({
        mode: 'merge',
        items: [{ source: 'orders', target: 'orders', filter: '{"qty":{"$gt":1}}' }],
      }),
    );
    const final = await waitForFinal(h.events);

    expect(h.runTool).not.toHaveBeenCalled();
    expect(h.merge).toHaveBeenCalledTimes(1);
    expect(h.merge.mock.calls[0]?.[0]).toMatchObject({ filter: { qty: { $gt: 1 } } });
    expect(final).toMatchObject({ documents: 2, done: true });
  });
});

describe('copy service: refusals', () => {
  it('refuses a filter that is not an EJSON object and starts no job', async () => {
    const h = harness();
    const start = h.service.start(
      options({ items: [{ source: 'orders', target: 'orders', filter: 'not json' }] }),
    );
    await expect(start).rejects.toMatchObject({
      error: { code: 'VALIDATION', message: expect.stringContaining('orders') },
    });
    expect(h.runTool).not.toHaveBeenCalled();
    expect(h.registry.markInUse).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it('refuses a blocking finding and starts no job', async () => {
    const h = harness({ sourceHost: 'db1:27017', targetHost: 'db1:27017' });
    await expect(
      h.service.start(options({ sourceDatabase: 'shop', targetDatabase: 'shop' })),
    ).rejects.toMatchObject({
      error: { code: 'VALIDATION', message: expect.stringContaining('also reads') },
    });
    expect(h.runTool).not.toHaveBeenCalled();
    expect(h.registry.markInUse).not.toHaveBeenCalled();
  });

  it('refuses a production target without the typed database name', async () => {
    const h = harness({ production: true });
    const refused = {
      error: { code: 'VALIDATION', message: expect.stringContaining('production') },
    };
    await expect(h.service.start(options())).rejects.toMatchObject(refused);
    await expect(h.service.start(options({ confirmation: 'Archive' }))).rejects.toMatchObject(
      refused,
    );
    expect(h.runTool).not.toHaveBeenCalled();
  });

  it('accepts a production target with the exact typed database name', async () => {
    const h = harness({ production: true });
    const jobId = await h.service.start(options({ confirmation: 'archive' }));
    const final = await waitForFinal(h.events);

    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.error).toBeUndefined();
  });

  it('starts a job on a connection that is not production without a confirmation', async () => {
    const h = harness({ production: false });
    const jobId = await h.service.start(options());
    await waitForFinal(h.events);

    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses merge into a time series target and runs nothing', async () => {
    const h = harness({
      targetNamespaces: [{ database: 'archive', collection: 'orders', type: 'timeseries' }],
    });
    await expect(h.service.start(options({ mode: 'merge' }))).rejects.toMatchObject({
      error: { code: 'VALIDATION', message: expect.stringContaining('time series') },
    });
    expect(h.merge).not.toHaveBeenCalled();
    expect(h.runTool).not.toHaveBeenCalled();
  });

  it('refuses a strong finding until the user acknowledges it', async () => {
    const h = harness({
      sourceNamespaces: [
        {
          database: 'shop',
          collection: 'orders',
          type: 'collection',
          documents: 2,
          encrypted: true,
        },
      ],
    });
    await expect(h.service.start(options())).rejects.toMatchObject({
      error: { code: 'VALIDATION', message: expect.stringContaining('Queryable Encryption') },
    });
    expect(h.runTool).not.toHaveBeenCalled();

    const jobId = await h.service.start(options({ acknowledged: ['encrypted-collections'] }));
    const final = await waitForFinal(h.events);
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.error).toBeUndefined();
  });
});

describe('copy service: stops and failures', () => {
  it('a dump failure aborts the restore and reports the dump error', async () => {
    const h = harness({
      runToolImpl: (options) =>
        options.binary.endsWith('mongodump')
          ? Promise.reject(
              new AppErrorException(
                appError('COMMAND_FAILED', 'mongodump failed with exit code 2.'),
              ),
            )
          : stoppedByCancel(options),
    });
    await h.service.start(options());
    const final = await waitForFinal(h.events);

    expect(h.runTool.mock.calls[1]?.[0].signal?.aborted).toBe(true);
    expect(final.error).toMatchObject({
      code: 'COMMAND_FAILED',
      message: 'mongodump failed with exit code 2.',
    });
    expect(h.rename).not.toHaveBeenCalled();
  });

  it('waits for both processes to exit before it drops the temporary collection', async () => {
    const restoreSettled = vi.fn();
    let releaseRestore = (): void => undefined;
    const h = harness({
      runToolImpl: (options) => {
        if (options.binary.endsWith('mongodump')) {
          return Promise.reject(
            new AppErrorException(appError('COMMAND_FAILED', 'mongodump failed with exit code 2.')),
          );
        }
        // The restore ignores its signal and settles only when the test releases it.
        return new Promise((_resolve, reject) => {
          releaseRestore = () => {
            restoreSettled();
            reject(
              new AppErrorException(appError('CANCELLED', 'The mongorestore run was cancelled.')),
            );
          };
        });
      },
    });
    await h.service.start(options());
    await vi.waitFor(() => {
      expect(h.runTool).toHaveBeenCalledTimes(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.dropIfExists).not.toHaveBeenCalled();

    releaseRestore();
    const final = await waitForFinal(h.events);
    const settledAt = restoreSettled.mock.invocationCallOrder[0] ?? 0;
    const droppedAt = h.dropIfExists.mock.invocationCallOrder[0] ?? 0;
    expect(droppedAt).toBeGreaterThan(settledAt);
    expect(final.error?.code).toBe('COMMAND_FAILED');
  });

  it('sends one event for a burst of lines, and the next one after the interval', async () => {
    const clock = { now: 0 };
    const toolOk = { exitCode: 0, signal: null, tail: [] };
    const h = harness({
      clock,
      runToolImpl: (options) => {
        if (options.binary.endsWith('mongodump')) return Promise.resolve(toolOk);
        clock.now = 300;
        for (let line = 0; line < 50; line += 1) {
          options.onLine({ kind: 'other', text: `line ${line}` }, `line ${line}`);
        }
        clock.now = 600;
        options.onLine({ kind: 'other', text: 'after the interval' }, 'after the interval');
        return Promise.resolve(toolOk);
      },
    });
    await h.service.start(options());
    await waitForFinal(h.events);

    const progress = h.events.flatMap((event) =>
      event.type === 'copy:progress' ? [event.progress] : [],
    );
    // Start, the first line of the burst, the rest of the burst with the next line, the collection
    // done and the final event each send at once.
    expect(progress.map((item) => item.lines.length)).toEqual([0, 1, 50, 0, 0]);
    expect(progress.map((item) => item.collectionsDone)).toEqual([0, 0, 0, 1, 1]);
    expect(progress.map((item) => item.done)).toEqual([false, false, false, false, true]);
  });

  it('cancelConnection cancels a job on that connection and leaves other jobs alone', async () => {
    const h = harness({ runsUntilAborted: true });
    const jobId = await h.service.start(options());
    await vi.waitFor(() => {
      expect(h.runTool).toHaveBeenCalledTimes(2);
    });

    h.service.cancelConnection('0b8e2f4a-1c3d-4e5f-8a6b-7c9d0e1f2a3b');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finalProgress(h.events)).toBeUndefined();

    h.service.cancelConnection(TARGET_ID);
    expect(await waitForFinal(h.events)).toMatchObject({ cancelled: true });
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('dispose cancels every running job and waits until each has cleaned up', async () => {
    const h = harness({ runsUntilAborted: true });
    await h.service.start(options());
    await vi.waitFor(() => {
      expect(h.runTool).toHaveBeenCalledTimes(2);
    });

    await h.service.dispose();
    expect(finalProgress(h.events)).toMatchObject({ cancelled: true });
    expect(h.dropIfExists).toHaveBeenCalledTimes(1);
    expect(leftoverConfigs()).toEqual([]);
  });
});

describe('copy service: time series source', () => {
  const timeseriesSource = [
    { database: 'shop', collection: 'orders', type: 'timeseries' as const, documents: 2 },
  ];

  it('replace writes in place with the bucket pair, and notes that counts are buckets', async () => {
    const h = harness({ sourceNamespaces: timeseriesSource });
    await h.service.start(options());
    const final = await waitForFinal(h.events);

    const restore = h.runTool.mock.calls[1]?.[0];
    expect(restore?.args).toContain('--drop');
    expect(restore?.args.slice(-4)).toEqual([
      '--nsFrom=shop.orders',
      '--nsTo=archive.orders',
      '--nsFrom=shop.system.buckets.orders',
      '--nsTo=archive.system.buckets.orders',
    ]);
    expect(restore?.args.join(' ')).not.toContain('__copy_');
    expect(h.rename).not.toHaveBeenCalled();
    expect(h.dropIfExists).not.toHaveBeenCalled();
    expect(final.error).toBeUndefined();
    expect(final.notes).toEqual([
      'shop.orders is a time series collection. Its counts are buckets, not points.',
      'archive.orders is written in place, because the source is a time series collection. A cancel leaves it partly filled.',
    ]);
  });

  it('insert only into a time series target writes the buckets in place', async () => {
    const h = harness({
      sourceNamespaces: timeseriesSource,
      targetNamespaces: [{ database: 'archive', collection: 'orders', type: 'timeseries' }],
    });
    await h.service.start(options({ mode: 'insertOnly' }));
    const final = await waitForFinal(h.events);

    const restore = h.runTool.mock.calls[1]?.[0];
    expect(restore?.args).toContain('--noIndexRestore');
    expect(restore?.args).toContain('--nsTo=archive.system.buckets.orders');
    expect(final.error).toBeUndefined();
  });

  it('refuses merge from a time series source and runs nothing', async () => {
    const h = harness({ sourceNamespaces: timeseriesSource });
    await expect(h.service.start(options({ mode: 'merge' }))).rejects.toMatchObject({
      error: { code: 'VALIDATION', message: expect.stringContaining('time series') },
    });
    expect(h.merge).not.toHaveBeenCalled();
    expect(h.runTool).not.toHaveBeenCalled();
  });

  it('refuses insert only from a time series source into an existing plain collection', async () => {
    const h = harness({
      sourceNamespaces: timeseriesSource,
      targetNamespaces: [{ database: 'archive', collection: 'orders', type: 'collection' }],
    });
    await expect(h.service.start(options({ mode: 'insertOnly' }))).rejects.toMatchObject({
      error: { code: 'VALIDATION', message: expect.stringContaining('not time series') },
    });
    expect(h.runTool).not.toHaveBeenCalled();
  });

  it('refuses replace from a time series source into an existing plain collection', async () => {
    const h = harness({
      sourceNamespaces: timeseriesSource,
      targetNamespaces: [{ database: 'archive', collection: 'orders', type: 'collection' }],
    });
    await expect(h.service.start(options({ mode: 'replace' }))).rejects.toMatchObject({
      error: { code: 'VALIDATION', message: expect.stringContaining('Drop the target first') },
    });
    expect(h.runTool).not.toHaveBeenCalled();
    expect(h.dropIfExists).not.toHaveBeenCalled();
    expect(h.rename).not.toHaveBeenCalled();
    expect(h.registry.markInUse).not.toHaveBeenCalled();
  });
});
