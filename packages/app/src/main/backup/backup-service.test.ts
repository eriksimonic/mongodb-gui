import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BackupSidecarSchema,
  type BackupInspection,
  type BackupProgress,
  type BackupServerInfo,
  type BackupStartInput,
  type RestoreStartInput,
  type RpcEvent,
  type ToolsInstall,
} from '@mongo-gui/core';
import type { Logger } from '../log';
import type { SpawnFn } from '../tools/probe';
import type { ResolvedTools } from '../tools/registry';
import { createBackupService, type BackupServiceDeps } from './backup-service';
import type { ToolsEndpoint } from './endpoint';
import { buildSidecar } from './sidecar-writer';

const CONNECTION_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const PASSWORD = 'Sup3r-Secret/Pass';
const ENCODED = encodeURIComponent(PASSWORD);
const RAW_URI = `mongodb://app:${ENCODED}@db1:27017/shop?replicaSet=rs0`;
const TOOLS_URI = `mongodb://app:${ENCODED}@db1:27017/?replicaSet=rs0&authSource=shop`;
const VERSION = '100.19.1';

type FakeChild = EventEmitter & {
  pid: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdin: PassThrough | null;
  stdout: PassThrough | null;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  args: string[];
  exit: (code: number | null, signal?: NodeJS.Signals | null) => void;
};

// What a fake tool does once spawned. It must call child.exit, now or later.
type Behaviour = (child: FakeChild) => void | Promise<void>;

function fakeChild(args: string[], stdio: unknown[]): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.args = args;
  child.stdin = stdio[0] === 'pipe' ? new PassThrough() : null;
  child.stdout = stdio[1] === 'pipe' ? new PassThrough() : null;
  child.stderr = new PassThrough();
  child.exit = (code, signal = null) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = signal;
    child.stdout?.end();
    child.stderr.end();
    setImmediate(() => child.emit('close', code, signal));
  };
  // A cancelled tool stops on SIGINT, as mongodump does.
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    setImmediate(() => child.exit(null, signal ?? 'SIGTERM'));
    return true;
  });
  return child;
}

function argValue(args: string[], flag: string): string | undefined {
  return args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

function serverInfo(overrides: Partial<BackupServerInfo> = {}): BackupServerInfo {
  return {
    serverVersion: '8.0.17',
    fcv: '8.0',
    storageEngine: 'wiredTiger',
    topology: 'replicaSet',
    setName: 'rs0',
    directConnection: false,
    hosts: ['db1:27017'],
    databases: ['shop', 'crm'],
    namespaces: [
      { database: 'shop', collection: 'orders', type: 'collection', documents: 2 },
      { database: 'shop', collection: 'users', type: 'collection', documents: 1 },
    ],
    namespacesTruncated: false,
    ...overrides,
  };
}

let root: string;
let folder: string;
let tmpRoot: string;
let binary: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'backup-service-'));
  folder = join(root, 'out');
  tmpRoot = join(root, 'tmp');
  mkdirSync(folder);
  binary = join(root, 'mongodump');
  writeFileSync(binary, 'fake mongodump binary');
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

function setup(behaviour: Behaviour, overrides: Partial<BackupServiceDeps<string>> = {}) {
  const events: RpcEvent[] = [];
  const logCalls: unknown[][] = [];
  const children: FakeChild[] = [];
  const release = vi.fn();
  const markInUse = vi.fn(() => release);
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
    mongodump: binary,
    mongorestore: join(root, 'mongorestore'),
  };
  const endpoint: ToolsEndpoint = {
    uri: TOOLS_URI,
    profileName: 'Shop',
    readPreference: 'primary',
    secrets: [RAW_URI, TOOLS_URI, ENCODED, PASSWORD],
    status: {
      state: 'connected',
      serverVersion: '8.0.17',
      topology: 'replicaSet',
      hosts: ['db1:27017'],
    },
  };
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      logCalls.push([level, ...args]);
    };
  const log: Logger = { info: record('info'), warn: record('warn'), error: record('error') };
  const spawn = vi.fn((_file: string, args: string[], options: { stdio: unknown[] }) => {
    const child = fakeChild(args, options.stdio);
    children.push(child);
    setImmediate(() => void behaviour(child));
    return child as unknown as ChildProcess;
  });
  const deps: BackupServiceDeps<string> = {
    registry: {
      resolve: vi.fn(async () => tools),
      list: vi.fn(async () => ({
        platform: { os: 'linux' as const, arch: 'x64' as const },
        bundledSupported: true,
        installs: [install],
        preference: 'auto' as const,
        resolved: VERSION,
      })),
      markInUse,
    },
    getClient: () => 'client',
    endpoint: vi.fn(async () => endpoint),
    readServerInfo: vi.fn(async () => serverInfo()),
    inspect: vi.fn(async () => {
      throw new Error('no inspection set');
    }),
    spawn: spawn as unknown as SpawnFn,
    emit: (event) => events.push(event),
    now: Date.now,
    tmpRoot,
    appVersion: '0.2.0',
    platform: 'linux',
    arch: 'x64',
    isPickedFolder: (path) => path === folder,
    env: { PATH: '/usr/bin' },
    log,
    progressIntervalMs: 0,
    killGraceMs: 50,
    ...overrides,
  };
  const service = createBackupService(deps);

  const progress = (): BackupProgress[] =>
    events.flatMap((event) => (event.type === 'backup:progress' ? [event.progress] : []));
  const finalEvent = async (): Promise<BackupProgress> => {
    await vi.waitFor(() => {
      expect(progress().some((item) => item.done)).toBe(true);
    });
    const last = progress().at(-1);
    if (last === undefined || !last.done) throw new Error('the final event is not last');
    return last;
  };
  const assertNoSecrets = (): void => {
    const text = JSON.stringify(events) + JSON.stringify(logCalls);
    for (const secret of [PASSWORD, ENCODED, RAW_URI, TOOLS_URI]) {
      expect(text).not.toContain(secret);
    }
  };
  const tempConfigsLeft = (): string[] =>
    existsSync(tmpRoot) ? readdirSync(tmpRoot).filter((name) => name.startsWith('tools-')) : [];
  return {
    service,
    deps,
    events,
    logCalls,
    children,
    spawn,
    markInUse,
    release,
    progress,
    finalEvent,
    assertNoSecrets,
    tempConfigsLeft,
  };
}

function dumpInput(overrides: Partial<BackupStartInput> = {}): BackupStartInput {
  return {
    connectionId: CONNECTION_ID,
    scope: { kind: 'database', database: 'shop' },
    options: {
      output: 'archive',
      gzip: true,
      excludeCollections: [],
      excludeCollectionsWithPrefix: [],
      oplog: false,
      dumpDbUsersAndRoles: false,
      viewsAsCollections: false,
      forceTableScan: false,
      numParallelCollections: 4,
      compressors: [],
    },
    folder,
    name: 'shop-backup',
    toolsVersion: VERSION,
    acknowledged: [],
    ...overrides,
  };
}

const ARCHIVE_BYTES = Buffer.from('archive bytes for the fake dump');

// A successful archive mongodump: data on stdout, progress and a leaked URI on stderr.
const archiveDump: Behaviour = (child) => {
  child.stderr.write('writing `shop.orders` to archive on stdout\n');
  child.stderr.write(`connecting to ${RAW_URI}\n`);
  child.stderr.write(`WARNING: password ${PASSWORD} looks weak\n`);
  child.stdout?.write(ARCHIVE_BYTES);
  child.stderr.write('done dumping `shop.orders` (2 documents)\n');
  child.stderr.write('done dumping `shop.users` (1 document)\n');
  child.exit(0);
};

describe('backup service dump', () => {
  it('writes an archive through a partial file, then its sidecar', async () => {
    const t = setup(archiveDump);
    const jobId = await t.service.startDump(dumpInput());
    const last = await t.finalEvent();

    const outputPath = join(folder, 'shop-backup.archive.gz');
    const sidecarPath = `${outputPath}.json`;
    const sha256 = createHash('sha256').update(ARCHIVE_BYTES).digest('hex');
    expect(last).toMatchObject({ done: true, cancelled: false, phase: 'finished', fraction: 1 });
    expect(last.error).toBeUndefined();
    expect(last.result).toEqual({
      kind: 'dump',
      outputPath,
      sidecarPath,
      bytes: ARCHIVE_BYTES.byteLength,
      sha256,
      documents: 3,
      namespaces: 2,
    });
    expect(readFileSync(outputPath)).toEqual(ARCHIVE_BYTES);
    expect(existsSync(`${outputPath}.partial`)).toBe(false);

    const sidecar = BackupSidecarSchema.parse(JSON.parse(readFileSync(sidecarPath, 'utf8')));
    expect(sidecar.output).toEqual({
      kind: 'archive',
      fileName: 'shop-backup.archive.gz',
      gzip: true,
      bytes: ARCHIVE_BYTES.byteLength,
      sha256,
    });
    expect(sidecar.source).toMatchObject({
      connectionName: 'Shop',
      uri: 'mongodb://db1:27017/?replicaSet=rs0&authSource=shop',
      hosts: ['db1:27017'],
      srv: false,
      serverVersion: '8.0.17',
      fcv: '8.0',
    });
    expect(sidecar.tools).toMatchObject({
      version: VERSION,
      source: 'bundled',
      os: 'linux',
      arch: 'x64',
      mongodumpSha256: createHash('sha256').update('fake mongodump binary').digest('hex'),
    });
    expect(sidecar.args.some((arg) => arg.startsWith('--config'))).toBe(false);
    expect(sidecar.args).toContain('--archive');
    expect(sidecar.databases).toEqual([
      {
        name: 'shop',
        collections: [
          { name: 'orders', type: 'collection', documents: 2, estimatedDocuments: 2 },
          { name: 'users', type: 'collection', documents: 1, estimatedDocuments: 1 },
        ],
      },
    ]);
    expect(sidecar.warnings).toHaveLength(1);
    expect(readFileSync(sidecarPath, 'utf8')).not.toContain(PASSWORD);

    expect(t.service.wroteFile(outputPath)).toBe(true);
    expect(t.service.wroteFile(sidecarPath)).toBe(true);
    expect(
      t.events.every((event) => event.type !== 'backup:progress' || event.jobId === jobId),
    ).toBe(true);
    expect(t.progress().map((item) => item.phase)).toEqual(
      expect.arrayContaining(['preparing', 'running', 'writing-sidecar', 'finished']),
    );
    expect(t.markInUse).toHaveBeenCalledWith(VERSION);
    await vi.waitFor(() => expect(t.release).toHaveBeenCalledTimes(1));
    expect(t.tempConfigsLeft()).toEqual([]);
    t.assertNoSecrets();
  });

  it('keeps a finished archive when its sidecar cannot be written', async () => {
    const outputPath = join(folder, 'shop-backup.archive.gz');
    const t = setup((child) => {
      // A folder in the sidecar's place makes the sidecar write fail after the dump.
      mkdirSync(`${outputPath}.json`);
      archiveDump(child);
    });
    await t.service.startDump(dumpInput());
    const last = await t.finalEvent();

    expect(last).toMatchObject({ done: true, cancelled: false });
    expect(last.error?.message).toContain(`The backup finished at ${outputPath}`);
    expect(readFileSync(outputPath)).toEqual(ARCHIVE_BYTES);
    expect(t.tempConfigsLeft()).toEqual([]);
    t.assertNoSecrets();
  });

  it('passes the config file and never the URI on the command line', async () => {
    let config = '';
    const t = setup((child) => {
      const path = argValue(child.args, '--config') ?? '';
      config = readFileSync(path, 'utf8');
      archiveDump(child);
    });
    await t.service.startDump(dumpInput());
    await t.finalEvent();
    expect(config).toBe(`uri: "${TOOLS_URI}"\n`);
    const [file, args, options] = t.spawn.mock.calls[0] ?? [];
    expect(file).toBe(binary);
    expect(JSON.stringify(args)).not.toContain(PASSWORD);
    expect(JSON.stringify(args)).not.toContain('db1');
    expect(args).toContain('--db=shop');
    expect(options).toMatchObject({ shell: false, windowsHide: true, env: { PATH: '/usr/bin' } });
  });

  it('removes the partial archive and writes no sidecar on cancel', async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const t = setup((child) => {
      child.stdout?.write(ARCHIVE_BYTES);
      child.stderr.write('writing `shop.orders` to archive on stdout\n');
      started();
    });
    const jobId = await t.service.startDump(dumpInput());
    await running;
    await vi.waitFor(() =>
      expect(existsSync(join(folder, 'shop-backup.archive.gz.partial'))).toBe(true),
    );
    t.service.cancel(jobId);
    const last = await t.finalEvent();

    expect(last).toMatchObject({ done: true, cancelled: true, error: { code: 'CANCELLED' } });
    expect(last.result).toBeUndefined();
    expect(t.children[0]?.kill).toHaveBeenCalledWith('SIGINT');
    expect(readdirSync(folder)).toEqual([]);
    expect(t.tempConfigsLeft()).toEqual([]);
    await vi.waitFor(() => expect(t.release).toHaveBeenCalledTimes(1));
    t.assertNoSecrets();
  });

  it('runs one mongodump per database into one folder, then hashes it', async () => {
    const t = setup((child) => {
      const out = argValue(child.args, '--out') ?? '';
      const database = argValue(child.args, '--db') ?? '';
      mkdirSync(join(out, database), { recursive: true });
      writeFileSync(join(out, database, 'items.bson'), `${database} data`);
      child.stderr.write(`done dumping \`${database}.items\` (5 documents)\n`);
      child.exit(0);
    });
    await t.service.startDump(
      dumpInput({
        scope: { kind: 'databases', databases: ['shop', 'crm'] },
        options: { ...dumpInput().options, output: 'directory', gzip: false },
      }),
    );
    const last = await t.finalEvent();
    const outputPath = join(folder, 'shop-backup');
    const sidecarPath = join(outputPath, 'mongo-gui-backup.json');

    expect(last.error).toBeUndefined();
    expect(t.spawn).toHaveBeenCalledTimes(2);
    expect(t.children.map((child) => argValue(child.args, '--db'))).toEqual(['shop', 'crm']);
    expect(t.children.every((child) => argValue(child.args, '--out') === outputPath)).toBe(true);
    expect(t.progress()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ currentDatabase: 'crm', databaseIndex: 2, databaseCount: 2 }),
        expect.objectContaining({ phase: 'hashing', totalBytes: 17 }),
      ]),
    );
    expect(last.result).toMatchObject({ kind: 'dump', outputPath, sidecarPath, bytes: 17 });
    expect(last.result).not.toHaveProperty('sha256');

    const sidecar = BackupSidecarSchema.parse(JSON.parse(readFileSync(sidecarPath, 'utf8')));
    expect(sidecar.scope).toEqual({ kind: 'databases', databases: ['shop', 'crm'] });
    expect(sidecar.output.kind).toBe('directory');
    if (sidecar.output.kind === 'directory') {
      expect(sidecar.output.files.map((file) => file.path)).toEqual([
        'crm/items.bson',
        'shop/items.bson',
      ]);
    }
    expect(sidecar.databases.map((db) => db.name)).toEqual(['shop', 'crm']);
    t.assertNoSecrets();
  });

  it('removes the dump folder after a failed run and skips the remaining databases', async () => {
    const t = setup((child) => {
      const out = argValue(child.args, '--out') ?? '';
      mkdirSync(join(out, 'shop'), { recursive: true });
      writeFileSync(join(out, 'shop', 'orders.bson'), 'partial');
      child.stderr.write(`Failed: cannot reach ${RAW_URI}\n`);
      child.exit(1);
    });
    await t.service.startDump(
      dumpInput({
        scope: { kind: 'databases', databases: ['shop', 'crm'] },
        options: { ...dumpInput().options, output: 'directory' },
      }),
    );
    const last = await t.finalEvent();

    expect(last).toMatchObject({ done: true, cancelled: false, error: { code: 'COMMAND_FAILED' } });
    expect(t.spawn).toHaveBeenCalledTimes(1);
    expect(readdirSync(folder)).toEqual([]);
    expect(t.tempConfigsLeft()).toEqual([]);
    t.assertNoSecrets();
  });

  it('reports a binary that cannot start as NOT_FOUND', async () => {
    const t = setup(() => undefined, {
      spawn: (() => {
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      }) as unknown as SpawnFn,
    });
    await t.service.startDump(dumpInput());
    const last = await t.finalEvent();
    expect(last.error?.code).toBe('NOT_FOUND');
    expect(readdirSync(folder)).toEqual([]);
    expect(t.tempConfigsLeft()).toEqual([]);
  });

  it('refuses a folder that was not picked', async () => {
    const t = setup(archiveDump);
    await expect(t.service.startDump(dumpInput({ folder: root }))).rejects.toMatchObject({
      error: { code: 'VALIDATION' },
    });
    expect(t.events).toEqual([]);
    expect(t.markInUse).not.toHaveBeenCalled();
  });

  it('refuses a name whose archive or sidecar exists', async () => {
    const t = setup(archiveDump);
    writeFileSync(join(folder, 'shop-backup.archive.gz.json'), '{}');
    await expect(t.service.startDump(dumpInput())).rejects.toMatchObject({
      error: { code: 'ALREADY_EXISTS' },
    });
    expect(t.spawn).not.toHaveBeenCalled();
  });

  it('refuses several databases with the archive format', async () => {
    const t = setup(archiveDump);
    await expect(
      t.service.startDump(dumpInput({ scope: { kind: 'databases', databases: ['shop', 'crm'] } })),
    ).rejects.toMatchObject({
      error: { code: 'VALIDATION', message: 'Several databases need the folder format.' },
    });
  });

  it('refuses an unacknowledged strong finding and accepts it once acknowledged', async () => {
    const encrypted = serverInfo({
      namespaces: [{ database: 'shop', collection: 'cards', type: 'collection', encrypted: true }],
    });
    const t = setup(archiveDump, { readServerInfo: async () => encrypted });
    await expect(t.service.startDump(dumpInput())).rejects.toMatchObject({
      error: { code: 'VALIDATION' },
    });
    expect(t.events).toEqual([]);
    await t.service.startDump(dumpInput({ acknowledged: ['encrypted-collections'] }));
    expect((await t.finalEvent()).error).toBeUndefined();
  });

  it('masks the password in a driver error during the start checks', async () => {
    const t = setup(archiveDump, {
      readServerInfo: async () => {
        throw new Error(`connect failed for ${RAW_URI} with ${PASSWORD}`);
      },
    });
    const failure = await t.service.startDump(dumpInput()).catch((error: unknown) => error);
    expect(JSON.stringify(failure)).not.toContain(PASSWORD);
    expect(JSON.stringify(failure)).not.toContain(ENCODED);
  });
});

function sidecarFor(sha256: string) {
  return buildSidecar({
    appVersion: '0.2.0',
    startedAt: '2026-10-10T10:00:00.000Z',
    finishedAt: '2026-10-10T10:00:05.000Z',
    tools: {
      version: VERSION,
      os: 'linux',
      arch: 'x64',
      source: 'bundled',
      mongodumpSha256: '0'.repeat(64),
    },
    source: {
      connectionName: 'Shop',
      uri: 'mongodb://db1:27017/',
      hosts: ['db1:27017'],
      srv: false,
      topology: 'replicaSet',
      directConnection: false,
      serverVersion: '8.0.17',
      fcv: '8.0',
    },
    scope: { kind: 'database', database: 'shop' },
    options: dumpInput().options,
    readPreferenceUsed: 'primary',
    args: ['--db=shop', '--archive'],
    output: { kind: 'archive', fileName: 'shop.archive.gz', gzip: true, bytes: 4, sha256 },
    databases: [
      { name: 'shop', collections: [{ name: 'orders', type: 'collection', documents: 10 }] },
    ],
    oplog: false,
    usersAndRoles: false,
    warnings: [],
  });
}

describe('backup service restore', () => {
  let archivePath: string;
  const content = Buffer.alloc(64 * 1024, 7);
  const sha256 = createHash('sha256').update(content).digest('hex');

  beforeEach(() => {
    archivePath = join(root, 'shop.archive.gz');
    writeFileSync(archivePath, content);
  });

  function inspection(overrides: Partial<BackupInspection> = {}): BackupInspection {
    return {
      path: archivePath,
      kind: 'archive',
      gzip: true,
      bytes: content.byteLength,
      sidecar: sidecarFor(sha256),
      namespaces: [{ database: 'shop', collection: 'orders', type: 'collection', documents: 10 }],
      hasOplog: false,
      hasUsersAndRoles: false,
      ...overrides,
    };
  }

  function restoreInput(options: Partial<RestoreStartInput['options']> = {}): RestoreStartInput {
    return {
      connectionId: CONNECTION_ID,
      source: archivePath,
      toolsVersion: VERSION,
      acknowledged: [],
      options: {
        renames: [],
        drop: false,
        dryRun: false,
        oplogReplay: false,
        restoreDbUsersAndRoles: false,
        preserveUUID: false,
        noIndexRestore: false,
        noOptionsRestore: false,
        convertLegacyIndexes: false,
        maintainInsertionOrder: false,
        stopOnError: false,
        bypassDocumentValidation: false,
        objcheck: false,
        writeConcern: 'majority',
        numParallelCollections: 4,
        numInsertionWorkersPerCollection: 1,
        verifyChecksum: true,
        ...options,
      },
    };
  }

  // Reads the archive from stdin, then reports a restore with some failures.
  const restoreWithFailures: Behaviour = async (child) => {
    let received = 0;
    for await (const chunk of child.stdin ?? []) received += (chunk as Buffer).byteLength;
    child.stderr.write(`received ${received}\n`);
    child.stderr.write('restoring `shop.orders` from archive\n');
    child.stderr.write('finished restoring `shop.orders` (8 documents, 2 failures)\n');
    child.stderr.write('8 document(s) restored successfully. 2 document(s) failed to restore.\n');
    child.exit(0);
  };

  it('verifies the checksum, pipes the archive and reports failed documents as done', async () => {
    const t = setup(restoreWithFailures, { inspect: async () => inspection() });
    await t.service.startRestore(restoreInput({ renames: [{ from: 'shop', to: 'shop_copy' }] }));
    const last = await t.finalEvent();

    expect(last.error).toBeUndefined();
    expect(last).toMatchObject({ done: true, cancelled: false, failedDocuments: 2 });
    expect(last.result).toEqual({
      kind: 'restore',
      dryRun: false,
      restored: 8,
      failed: 2,
      databases: ['shop_copy'],
      plan: [],
    });
    const phases = t.progress().map((item) => item.phase);
    expect(phases.indexOf('verifying')).toBeLessThan(phases.indexOf('running'));
    expect(t.progress().flatMap((item) => item.lines)).toContain(`received ${content.byteLength}`);
    expect(
      t
        .progress()
        .some((item) => item.phase === 'running' && item.totalBytes === content.byteLength),
    ).toBe(true);
    const args = t.children[0]?.args ?? [];
    expect(args).toEqual(
      expect.arrayContaining(['--archive', '--gzip', '--nsFrom=shop.*', '--nsTo=shop_copy.*']),
    );

    const changed = t.events.filter((event) => event.type === 'catalog:changed');
    expect(changed).toEqual([
      { type: 'catalog:changed', connectionId: CONNECTION_ID, database: 'shop_copy' },
    ]);
    expect(t.events.indexOf(changed[0] as RpcEvent)).toBeGreaterThan(
      t.events.findIndex((event) => event.type === 'backup:progress' && event.progress.done),
    );
    expect(t.tempConfigsLeft()).toEqual([]);
    t.assertNoSecrets();
  });

  it('stops before the tool when the archive does not match its checksum', async () => {
    const t = setup(restoreWithFailures, {
      inspect: async () => inspection({ sidecar: sidecarFor('f'.repeat(64)) }),
    });
    await t.service.startRestore(restoreInput());
    const last = await t.finalEvent();
    expect(last.error).toMatchObject({
      code: 'VALIDATION',
      message: 'The archive does not match the checksum in its backup description.',
    });
    expect(t.spawn).not.toHaveBeenCalled();
    expect(t.events.some((event) => event.type === 'catalog:changed')).toBe(false);
    expect(t.tempConfigsLeft()).toEqual([]);
  });

  it('skips the checksum when the user turns it off', async () => {
    const t = setup(restoreWithFailures, {
      inspect: async () => inspection({ sidecar: sidecarFor('f'.repeat(64)) }),
    });
    await t.service.startRestore(restoreInput({ verifyChecksum: false }));
    const last = await t.finalEvent();
    expect(last.error).toBeUndefined();
    expect(t.progress().some((item) => item.phase === 'verifying')).toBe(false);
  });

  it('returns a dry run plan with renames and changes no catalog', async () => {
    const t = setup(
      async (child) => {
        // Drain the archive.
        child.stdin?.resume();
        await new Promise((resolve) => child.stdin?.on('end', resolve));
        child.stderr.write('restoring `shop.orders` from archive\n');
        child.stderr.write('restoring `shop.users` from archive\n');
        child.exit(0);
      },
      { inspect: async () => inspection() },
    );
    await t.service.startRestore(
      restoreInput({ dryRun: true, renames: [{ from: 'shop', to: 'shop_copy' }] }),
    );
    const last = await t.finalEvent();
    expect(last.result).toMatchObject({
      kind: 'restore',
      dryRun: true,
      plan: [
        { from: 'shop.orders', to: 'shop_copy.orders' },
        { from: 'shop.users', to: 'shop_copy.users' },
      ],
    });
    expect(t.children[0]?.args).toEqual(expect.arrayContaining(['--dryRun', '-v']));
    expect(t.events.some((event) => event.type === 'catalog:changed')).toBe(false);
  });

  it('announces catalog changes after a cancelled restore', async () => {
    const t = setup(
      (child) => {
        child.stderr.write('restoring `shop.orders` from archive\n');
      },
      { inspect: async () => inspection({ sidecar: undefined }) },
    );
    const jobId = await t.service.startRestore(restoreInput());
    await vi.waitFor(() => expect(t.children).toHaveLength(1));
    t.service.cancelConnection(CONNECTION_ID);
    const last = await t.finalEvent();
    expect(last).toMatchObject({ cancelled: true, error: { code: 'CANCELLED' } });
    expect(t.events.some((event) => event.type === 'catalog:changed')).toBe(true);
    expect(t.tempConfigsLeft()).toEqual([]);
    t.service.cancel(jobId);
  });

  it('starts when the include leaves out an encrypted collection', async () => {
    const t = setup(restoreWithFailures, {
      inspect: async () =>
        inspection({
          namespaces: [
            { database: 'shop', collection: 'orders', type: 'collection', documents: 10 },
            { database: 'shop', collection: 'cards', type: 'collection', encrypted: true },
          ],
        }),
    });
    await expect(
      t.service.startRestore(restoreInput({ include: ['shop.orders'] })),
    ).resolves.toEqual(expect.any(String));
    await expect(t.service.startRestore(restoreInput())).rejects.toMatchObject({
      error: { code: 'VALIDATION' },
    });
    await t.finalEvent();
  });

  it('refuses a confirmable block until the connection name is typed', async () => {
    const older = sidecarFor(sha256);
    older.source.serverVersion = '7.0.12';
    older.source.fcv = '7.0';
    const t = setup(restoreWithFailures, {
      inspect: async () => inspection({ sidecar: older }),
    });
    await expect(
      t.service.startRestore({ ...restoreInput(), acknowledged: ['tools-version-mismatch'] }),
    ).rejects.toMatchObject({ error: { code: 'VALIDATION' } });
    expect(t.events).toEqual([]);
    await t.service.startRestore({ ...restoreInput(), confirmation: 'Shop' });
    expect((await t.finalEvent()).error).toBeUndefined();
  });

  it('restores a database folder from a private folder that holds only a link to it', async () => {
    const parent = join(root, 'Downloads');
    const picked = join(parent, 'shop');
    mkdirSync(picked, { recursive: true });
    writeFileSync(join(picked, 'orders.bson'), '');
    // mongorestore rejects a folder name that is not a valid database name.
    mkdirSync(join(parent, 'My Files'));
    let seen: { dir: string; entries: string[]; target: string } | undefined;
    const t = setup(
      (child) => {
        const dir = argValue(child.args, '--dir');
        if (dir !== undefined) {
          seen = { dir, entries: readdirSync(dir), target: realpathSync(join(dir, 'shop')) };
        }
        child.exit(0);
      },
      {
        inspect: async () =>
          inspection({ path: picked, kind: 'directory', layout: 'database', gzip: false }),
      },
    );
    await t.service.startRestore({ ...restoreInput(), source: picked });
    expect((await t.finalEvent()).error).toBeUndefined();
    expect(seen?.dir).not.toBe(parent);
    expect(seen?.entries).toEqual(['shop']);
    expect(seen?.target).toBe(realpathSync(picked));
    expect(t.children[0]?.args).toContain('--nsInclude=shop.*');
    expect(t.tempConfigsLeft()).toEqual([]);
    expect(readdirSync(picked)).toEqual(['orders.bson']);
  });

  it('refuses option problems before anything runs', async () => {
    const t = setup(restoreWithFailures, { inspect: async () => inspection() });
    await expect(t.service.startRestore(restoreInput({ oplogReplay: true }))).rejects.toMatchObject(
      { error: { code: 'VALIDATION', message: 'The backup holds no oplog.' } },
    );
    expect(t.markInUse).not.toHaveBeenCalled();
  });
});

describe('backup service shutdown', () => {
  it('cancels every job on dispose and kills a tool that ignores SIGINT', async () => {
    const t = setup(() => undefined, { disposeWaitMs: 20 });
    // This child ignores SIGINT and only stops on SIGKILL.
    t.spawn.mockImplementation((_file: string, args: string[], options: { stdio: unknown[] }) => {
      const child = fakeChild(args, options.stdio);
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        if (signal === 'SIGKILL') setImmediate(() => child.exit(null, 'SIGKILL'));
        return true;
      });
      t.children.push(child);
      return child as unknown as ChildProcess;
    });
    await t.service.startDump(dumpInput({ name: 'first' }));
    await vi.waitFor(() => expect(t.children).toHaveLength(1));
    await t.service.dispose();
    const last = await t.finalEvent();
    expect(last).toMatchObject({ cancelled: true });
    expect(t.children[0]?.kill).toHaveBeenCalledWith('SIGINT');
    expect(t.children[0]?.kill).toHaveBeenCalledWith('SIGKILL');
    expect(readdirSync(folder)).toEqual([]);
    expect(t.tempConfigsLeft()).toEqual([]);
  });

  it('ignores unknown job ids', () => {
    const t = setup(archiveDump);
    expect(() => t.service.cancel('11111111-2222-4333-8444-555555555555')).not.toThrow();
    expect(() => t.service.cancelAll()).not.toThrow();
    expect(t.service.wroteFile('/nowhere')).toBe(false);
  });
});
