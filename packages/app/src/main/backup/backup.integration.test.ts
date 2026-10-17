import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BackupSidecarSchema,
  DumpOptionsSchema,
  RestoreOptionsSchema,
  type BackupProgress,
  type BackupStartInput,
  type RestoreStartInput,
  type RpcEvent,
} from '@mongo-gui/core';
import { readArchivePrelude, readBackupServerInfo } from '@mongo-gui/mongo-adapter';
import {
  CONTAINER_STARTUP_TIMEOUT_MS,
  SEED_DB,
  seedCatalog,
  startMongo,
  supportsTimeseries,
  type StartedMongo,
} from '../../../../mongo-adapter/src/test/mongo-container';
import { createToolsRegistry } from '../tools/registry';
import { createBackupService, type BackupService } from './backup-service';
import type { ToolsEndpoint } from './endpoint';
import { inspectBackup } from './inspect';

// The floating mongo:8.0 tag refuses to start on Linux kernels 6.19 and newer (SERVER-121912).
const IMAGES = ['mongo:4.4', 'mongo:8.0.17'] as const;
const SUITE_TIMEOUT_MS = CONTAINER_STARTUP_TIMEOUT_MS + 240_000;
const JOB_TIMEOUT_MS = 90_000;
const SECRET = 'integration-secret';
const CONNECTION_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const BIG_DB = 'bigdata';
const BIG_BATCHES = 30;
const BIG_BATCH_SIZE = 5000;

const appRoot = join(__dirname, '..', '..', '..');
const toolsDir =
  process.env['MONGO_TOOLS_DIR'] ??
  join(appRoot, 'resources', 'mongo-tools', `${process.platform}-${process.arch}`);
const hasTools = existsSync(join(toolsDir, 'install.json'));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!hasTools).each(IMAGES)('backup and restore with the real tools on %s', (image) => {
  let mongo: StartedMongo;
  let client: MongoClient;
  let work: string;
  let events: RpcEvent[];
  let service: BackupService;
  let toolsVersion: string;
  let binDir: string;
  const sidecarTexts: string[] = [];

  const progressOf = (jobId: string): BackupProgress[] =>
    events.flatMap((event) =>
      event.type === 'backup:progress' && event.jobId === jobId ? [event.progress] : [],
    );

  async function finish(jobId: string): Promise<BackupProgress> {
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    for (;;) {
      const last = progressOf(jobId).find((progress) => progress.done);
      if (last !== undefined) return last;
      if (Date.now() > deadline) throw new Error('the job did not finish in time');
      await sleep(50);
    }
  }

  function dumpInput(
    folder: string,
    name: string,
    scope: BackupStartInput['scope'],
    options: Partial<BackupStartInput['options']> = {},
  ): BackupStartInput {
    return {
      connectionId: CONNECTION_ID,
      scope,
      options: DumpOptionsSchema.parse(options),
      folder,
      name,
      toolsVersion,
      acknowledged: [],
    };
  }

  function restoreInput(
    source: string,
    options: Partial<RestoreStartInput['options']> = {},
  ): RestoreStartInput {
    return {
      connectionId: CONNECTION_ID,
      source,
      toolsVersion,
      options: RestoreOptionsSchema.parse(options),
      acknowledged: [],
    };
  }

  async function runDump(input: BackupStartInput): Promise<BackupProgress> {
    return finish(await service.startDump(input));
  }

  async function runRestore(input: RestoreStartInput): Promise<BackupProgress> {
    return finish(await service.startRestore(input));
  }

  function readSidecar(path: string) {
    const text = readFileSync(path, 'utf8');
    sidecarTexts.push(text);
    return BackupSidecarSchema.parse(JSON.parse(text));
  }

  const databaseNames = async (): Promise<string[]> =>
    (await client.db().admin().listDatabases()).databases.map((database) => database.name);

  beforeAll(async () => {
    mongo = await startMongo(image);
    await seedCatalog(mongo.rootUri, supportsTimeseries(image));
    client = new MongoClient(mongo.rootUri);
    await client.connect();
    work = mkdtempSync(join(tmpdir(), 'backup-it-'));
    events = [];
    // The tools folder is used as the bundled install, wherever it lives.
    const roots = {
      bundled: toolsDir,
      downloaded: join(work, 'downloaded'),
      tmp: join(work, 'tmp'),
    };
    const registry = createToolsRegistry({
      roots,
      spawn,
      platform: process.platform,
      arch: process.arch,
    });
    mkdirSync(roots.tmp, { recursive: true });
    const listed = await registry.list('auto');
    if (listed.resolved === undefined) throw new Error('no healthy tools install found');
    toolsVersion = listed.resolved;
    binDir = join(toolsDir, 'bin');
    const hostPort = /@([^/]+)\//.exec(mongo.rootUri)?.[1] ?? '';
    const endpoint: ToolsEndpoint = {
      uri: mongo.rootUri,
      profileName: 'Integration',
      readPreference: 'primary',
      secrets: [mongo.rootUri, SECRET],
      status: {
        state: 'connected',
        serverVersion: image.slice('mongo:'.length),
        topology: 'standalone',
        hosts: [hostPort],
      },
    };
    service = createBackupService({
      registry: registry,
      getClient: () => client,
      endpoint: async () => endpoint,
      readServerInfo: readBackupServerInfo,
      inspect: (path) => inspectBackup(path, { readPrelude: readArchivePrelude }),
      spawn,
      emit: (event) => events.push(event),
      now: () => Date.now(),
      tmpRoot: roots.tmp,
      appVersion: '0.0.0-test',
      platform: process.platform,
      arch: process.arch,
      isPickedFolder: () => true,
    });
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    await service?.dispose();
    await client?.close();
    await mongo?.stop();
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
    // beforeAll failed before any events were recorded. Return so its error is the one reported.
    if (events === undefined) return;
    // Nothing the app emitted or wrote may carry the password.
    expect(JSON.stringify(events)).not.toContain(SECRET);
    for (const text of sidecarTexts) expect(text).not.toContain(SECRET);
  }, SUITE_TIMEOUT_MS);

  it('dumps shop to a gzip archive with a matching sidecar', async () => {
    const folder = join(work, 'case1');
    mkdirSync(folder);
    const result = await runDump(
      dumpInput(folder, 'shop-dump', { kind: 'database', database: SEED_DB }),
    );
    expect(result.error).toBeUndefined();
    expect(result.result?.kind).toBe('dump');
    const archive = join(folder, 'shop-dump.archive.gz');
    const sidecar = readSidecar(`${archive}.json`);
    if (sidecar.output.kind !== 'archive') throw new Error('expected an archive');
    expect(sidecar.output.sha256).toBe(
      createHash('sha256').update(readFileSync(archive)).digest('hex'),
    );
    const shop = sidecar.databases.find((database) => database.name === SEED_DB);
    const orders = shop?.collections.find((collection) => collection.name === 'orders');
    expect(orders?.documents).toBe(await client.db(SEED_DB).collection('orders').countDocuments());
    expect(orders?.documents).toBeGreaterThan(0);
    expect(readdirSync(folder).sort()).toEqual([
      'shop-dump.archive.gz',
      'shop-dump.archive.gz.json',
    ]);
  });

  it('restores that archive under a new database name', async () => {
    const archive = join(work, 'case1', 'shop-dump.archive.gz');
    const result = await runRestore(
      restoreInput(archive, { renames: [{ from: SEED_DB, to: 'shop_copy' }] }),
    );
    expect(result.error).toBeUndefined();
    const source = client.db(SEED_DB);
    const copy = client.db('shop_copy');
    for (const name of ['orders', 'events']) {
      expect(await copy.collection(name).countDocuments()).toBe(
        await source.collection(name).countDocuments(),
      );
    }
    const kinds = new Map(
      (await copy.listCollections().toArray()).map((entry) => [entry.name, entry.type]),
    );
    expect(kinds.get('paidOrders')).toBe('view');
    const indexes = (await copy.collection('orders').indexes()).map((index) => index.name);
    expect(indexes).toContain('status_1_createdAt_-1');
  });

  it('restores one collection from a folder dump of the server', async () => {
    const folder = join(work, 'case3');
    mkdirSync(folder);
    const dump = await runDump(
      dumpInput(folder, 'server-dump', { kind: 'server' }, { output: 'directory', gzip: false }),
    );
    expect(dump.error).toBeUndefined();
    const dir = join(folder, 'server-dump');
    readSidecar(join(dir, 'mongo-gui-backup.json'));
    await client.db('shop_copy').dropDatabase();
    const result = await runRestore(
      restoreInput(dir, {
        include: [`${SEED_DB}.orders`],
        renames: [{ from: SEED_DB, to: 'shop_copy' }],
      }),
    );
    expect(result.error).toBeUndefined();
    const names = (await client.db('shop_copy').listCollections().toArray()).map(
      (entry) => entry.name,
    );
    expect(names).toEqual(['orders']);
    expect(await client.db('shop_copy').collection('orders').countDocuments()).toBeGreaterThan(0);
  });

  it('plans a dry run and restores nothing', async () => {
    const archive = join(work, 'case1', 'shop-dump.archive.gz');
    const result = await runRestore(
      restoreInput(archive, { dryRun: true, renames: [{ from: SEED_DB, to: 'shop_dry' }] }),
    );
    expect(result.error).toBeUndefined();
    expect(result.result?.kind === 'restore' && result.result.dryRun).toBe(true);
    expect(result.result?.kind === 'restore' && result.result.plan.length).toBeGreaterThan(0);
    expect(await databaseNames()).not.toContain('shop_dry');
  });

  it('cancels a dump of a large collection and leaves no file', async () => {
    const big = client.db(BIG_DB).collection('rows');
    const padding = 'x'.repeat(1024);
    for (let batch = 0; batch < BIG_BATCHES; batch++) {
      await big.insertMany(
        Array.from({ length: BIG_BATCH_SIZE }, (_, index) => ({
          n: batch * BIG_BATCH_SIZE + index,
          padding,
        })),
      );
    }
    const folder = join(work, 'case5');
    mkdirSync(folder);
    const jobId = await service.startDump(
      dumpInput(folder, 'big', { kind: 'database', database: BIG_DB }, { gzip: false }),
    );
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    while (!progressOf(jobId).some((progress) => progress.phase === 'running')) {
      if (Date.now() > deadline) throw new Error('the dump never started running');
      await sleep(10);
    }
    service.cancel(jobId);
    const result = await finish(jobId);
    expect(result.cancelled).toBe(true);
    expect(readdirSync(folder)).toEqual([]);
    await client.db(BIG_DB).dropDatabase();
  });

  it('refuses users and roles with a rename, as mongorestore does', async () => {
    // Recorded with mongorestore 100.19.1: --restoreDbUsersAndRoles needs --db, and with --db plus
    // a rename it still stops with "No users or roles found in restore target". Without a rename
    // and without --db it stops with "cannot use --restoreDbUsersAndRoles without a specified
    // database". The option problem rule stays.
    const folder = join(work, 'case6');
    mkdirSync(folder);
    await client.db(SEED_DB).command({
      createUser: 'reader',
      pwd: 'reader-pass',
      roles: [{ role: 'read', db: SEED_DB }],
    });
    const dump = await runDump(
      dumpInput(
        folder,
        'users',
        { kind: 'database', database: SEED_DB },
        { dumpDbUsersAndRoles: true },
      ),
    );
    expect(dump.error).toBeUndefined();
    const archive = join(folder, 'users.archive.gz');
    await expect(
      service.startRestore(
        restoreInput(archive, {
          restoreDbUsersAndRoles: true,
          renames: [{ from: SEED_DB, to: 'shop_users' }],
        }),
      ),
    ).rejects.toThrow(/renaming/);
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(
        join(binDir, process.platform === 'win32' ? 'mongorestore.exe' : 'mongorestore'),
        [
          `--uri=${mongo.rootUri}`,
          `--archive=${archive}`,
          '--gzip',
          `--db=shop_users`,
          `--nsFrom=${SEED_DB}.*`,
          `--nsTo=shop_users.*`,
          '--restoreDbUsersAndRoles',
        ],
        { stdio: 'ignore' },
      );
      child.on('close', resolve);
    });
    expect(code).not.toBe(0);
    expect(await databaseNames()).not.toContain('shop_users');
    await client.db(SEED_DB).command({ dropUser: 'reader' });
  });
});
