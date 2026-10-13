import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  AppErrorException,
  appError,
  type AppError,
  type BackupInspection,
  type BackupServerInfo,
  type ConnectionProfile,
  type ConnectionStatus,
  type ConnectionTestResult,
  type RpcEvent,
  type RpcResult,
  type ToolsListOutput,
} from '@mongo-gui/core';
import { EncryptedStore, Vault } from '@mongo-gui/storage';
import type { BackupService } from '../backup/backup-service';
import type { ToolsDownloads } from '../tools/download-service';
import {
  createRepos,
  createRouter,
  type BackupTools,
  type BackupToolsWiring,
  type ConnectionRegistry,
  type NativeDialogs,
  type Router,
  type StoreHandles,
} from './router';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';
const CONNECTED: ConnectionStatus = {
  state: 'connected',
  serverVersion: '8.0.17',
  topology: 'standalone',
  hosts: ['localhost:27017'],
};
const JOB_ID = '0b9f6c1e-7d43-4a8e-9a54-3f0f5c1d2e7a';
const DOWNLOAD_ID = '5a1c3e2b-8f4d-4b6a-9c7e-1d2f3a4b5c6d';
const VERSION = '100.19.1';

const SERVER_INFO: BackupServerInfo = {
  serverVersion: '8.0.17',
  fcv: '8.0',
  storageEngine: 'wiredTiger',
  topology: 'standalone',
  directConnection: false,
  hosts: ['localhost:27017'],
  databases: ['shop'],
  namespaces: [],
  namespacesTruncated: false,
};

const TOOLS_LIST: ToolsListOutput = {
  platform: { os: 'linux', arch: 'x64' },
  bundledSupported: true,
  installs: [
    {
      id: 'bundled',
      source: 'bundled',
      version: VERSION,
      location: '/opt/tools',
      sizeBytes: 1,
      health: { state: 'ok' },
      inUse: false,
    },
  ],
  preference: 'auto',
  resolved: VERSION,
};

function inspection(path: string, kind: BackupInspection['kind']): BackupInspection {
  return {
    path,
    kind,
    gzip: kind === 'archive',
    bytes: 10,
    namespaces: [],
    hasOplog: false,
    hasUsersAndRoles: false,
  };
}

interface FakeTools extends BackupTools {
  readonly backups: BackupService & {
    startDump: Mock<BackupService['startDump']>;
    startRestore: Mock<BackupService['startRestore']>;
    cancel: Mock<BackupService['cancel']>;
    cancelConnection: Mock<BackupService['cancelConnection']>;
    cancelAll: Mock<BackupService['cancelAll']>;
    wroteFile: Mock<BackupService['wroteFile']>;
  };
  readonly downloads: ToolsDownloads & {
    start: Mock<ToolsDownloads['start']>;
    cancel: Mock<ToolsDownloads['cancel']>;
    cancelAll: Mock<ToolsDownloads['cancelAll']>;
  };
  readonly inspect: Mock<BackupTools['inspect']>;
  readonly listCalls: string[];
  wiring?: BackupToolsWiring;
}

/** Backup and tools services that answer with fixed values and record the calls. */
function fakeTools(): FakeTools {
  const listCalls: string[] = [];
  return {
    listCalls,
    registry: {
      list: vi.fn(async (preference: string) => {
        listCalls.push(preference);
        return { ...TOOLS_LIST, preference } as ToolsListOutput;
      }),
      remove: vi.fn(async () => undefined),
      licence: vi.fn(async () => ({ version: VERSION, licence: 'Apache', thirdPartyNotices: '' })),
    },
    feed: {
      available: vi.fn(async (installed: readonly string[]) => ({
        fetchedAt: new Date(0).toISOString(),
        versions: [
          {
            version: VERSION,
            target: 'ubuntu2004',
            installed: installed.includes(VERSION),
          },
        ],
      })),
    },
    downloads: {
      start: vi.fn<ToolsDownloads['start']>(async () => ({ downloadId: DOWNLOAD_ID })),
      cancel: vi.fn<ToolsDownloads['cancel']>(),
      cancelAll: vi.fn<ToolsDownloads['cancelAll']>(),
    },
    backups: {
      startDump: vi.fn<BackupService['startDump']>(async () => JOB_ID),
      startRestore: vi.fn<BackupService['startRestore']>(async () => JOB_ID),
      cancel: vi.fn<BackupService['cancel']>(),
      cancelConnection: vi.fn<BackupService['cancelConnection']>(),
      cancelAll: vi.fn<BackupService['cancelAll']>(),
      wroteFile: vi.fn<BackupService['wroteFile']>(() => false),
      dispose: vi.fn(async () => undefined),
    },
    describeServer: vi.fn(async () => SERVER_INFO),
    inspect: vi.fn<BackupTools['inspect']>(async (path) =>
      inspection(path, path.endsWith('.gz') ? 'archive' : 'directory'),
    ),
  };
}

interface FakeConnections extends ConnectionRegistry {
  emitStatus(connectionId: string, status: ConnectionStatus): void;
}

/** A ConnectionManager stand-in. getClient returns a marker the fake describeServer ignores. */
function fakeConnections(): FakeConnections {
  const listeners = new Set<(connectionId: string, status: ConnectionStatus) => void>();
  return {
    async connect() {
      return CONNECTED;
    },
    async disconnect() {
      return undefined;
    },
    async disconnectAll() {
      return undefined;
    },
    status() {
      return CONNECTED;
    },
    getClient() {
      return {} as ReturnType<ConnectionRegistry['getClient']>;
    },
    async test(): Promise<ConnectionTestResult> {
      return { ok: true, serverVersion: '8.0.17', topology: 'standalone' };
    },
    onStatusChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emitStatus(connectionId, status) {
      for (const listener of listeners) {
        listener(connectionId, status);
      }
    },
  };
}

interface Harness {
  readonly router: Router;
  readonly vault: Vault;
  readonly tools: FakeTools;
  readonly connections: FakeConnections;
  readonly shown: string[];
  readonly events: RpcEvent[];
  /** The path the next open dialog returns. */
  nextPick: string | undefined;
}

let dir: string;
let handles: StoreHandles | undefined;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'router-backup-')));
});

afterEach(() => {
  handles?.store.close();
  handles = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function buildHarness(options: { withTools?: boolean } = {}): Harness {
  const lockListeners = new Set<() => void>();
  const vault = new Vault({
    dir,
    kdf: FAST_KDF,
    failureDelayMs: 0,
    onLocked: () => {
      for (const listener of lockListeners) {
        listener();
      }
    },
  });
  const store = new EncryptedStore({ path: join(dir, 'store.sqlite'), vault });
  handles = { store, repos: createRepos(store) };
  const tools = fakeTools();
  const connections = fakeConnections();
  const shown: string[] = [];
  const events: RpcEvent[] = [];
  const harness: Harness = {
    router: undefined as unknown as Router,
    vault,
    tools,
    connections,
    shown,
    events,
    nextPick: undefined,
  };
  const dialogs: NativeDialogs = {
    showOpenDialog: async () => (harness.nextPick === undefined ? {} : { path: harness.nextPick }),
    showSaveDialog: async () => ({}),
    showItemInFolder: (path) => {
      shown.push(path);
    },
  };
  const router = createRouter({
    vault,
    store,
    repos: handles.repos,
    connections,
    onEvent: (event) => {
      events.push(event);
    },
    lockEvents: {
      subscribe(listener) {
        lockListeners.add(listener);
        return () => {
          lockListeners.delete(listener);
        };
      },
    },
    dialogs,
    ...(options.withTools === false
      ? {}
      : {
          backupTools: (wiring: BackupToolsWiring) => {
            tools.wiring = wiring;
            return tools;
          },
        }),
  });
  return Object.assign(harness, { router });
}

function expectError(result: RpcResult, code: AppError['code']): AppError {
  if (result.ok) {
    throw new Error(`expected ${code}, got ok with ${JSON.stringify(result.value)}`);
  }
  expect(result.error.code).toBe(code);
  return result.error;
}

function expectValue(result: RpcResult): unknown {
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

/** Sets up the vault and saves one profile. Returns its id. */
async function unlockWithProfile(harness: Harness): Promise<string> {
  expectValue(await harness.router.handle('vault.initialise', { password: PASSWORD }));
  const created = expectValue(
    await harness.router.handle('connections.create', {
      name: 'Local',
      uri: 'mongodb://localhost:27017',
    }),
  ) as ConnectionProfile;
  return created.id;
}

async function pick(harness: Harness, path: string, directory: boolean): Promise<void> {
  harness.nextPick = path;
  expectValue(
    await harness.router.handle('app.showOpenDialog', { title: 't', filters: [], directory }),
  );
}

function startInput(connectionId: string, folder: string) {
  return {
    connectionId,
    scope: { kind: 'server' },
    options: {},
    folder,
    name: 'local-backup',
    toolsVersion: VERSION,
  };
}

function restoreInput(connectionId: string, source: string) {
  return { connectionId, source, toolsVersion: VERSION, options: {} };
}

describe('backup calls', () => {
  it('answers every backup and tools call through the services', async () => {
    const harness = buildHarness();
    const { router, tools } = harness;
    const connectionId = await unlockWithProfile(harness);
    const folder = join(dir, 'out');
    mkdirSync(folder);
    await pick(harness, folder, true);

    expect(
      expectValue(await router.handle('backup.describeServer', { connectionId })),
    ).toMatchObject({ serverVersion: '8.0.17' });
    expect(
      expectValue(await router.handle('backup.start', startInput(connectionId, folder))),
    ).toEqual({ jobId: JOB_ID });
    expect(expectValue(await router.handle('backup.inspect', { path: folder }))).toMatchObject({
      path: folder,
      kind: 'directory',
    });
    expect(
      expectValue(await router.handle('backup.startRestore', restoreInput(connectionId, folder))),
    ).toEqual({ jobId: JOB_ID });
    expectValue(await router.handle('backup.cancel', { jobId: JOB_ID }));
    expect(tools.backups.cancel).toHaveBeenCalledWith(JOB_ID);

    expect(expectValue(await router.handle('tools.list', undefined))).toMatchObject({
      resolved: VERSION,
    });
    expect(expectValue(await router.handle('tools.available', { refresh: true }))).toMatchObject({
      versions: [{ version: VERSION, installed: true }],
    });
    expect(tools.feed.available).toHaveBeenCalledWith([VERSION], true);
    expect(expectValue(await router.handle('tools.download', { version: VERSION }))).toEqual({
      downloadId: DOWNLOAD_ID,
    });
    expectValue(await router.handle('tools.cancelDownload', { downloadId: DOWNLOAD_ID }));
    expect(tools.downloads.cancel).toHaveBeenCalledWith(DOWNLOAD_ID);
    expectValue(await router.handle('tools.remove', { id: `downloaded:${VERSION}` }));
    expect(tools.registry.remove).toHaveBeenCalledWith(`downloaded:${VERSION}`);
    expect(expectValue(await router.handle('tools.licence', { id: 'bundled' }))).toMatchObject({
      licence: 'Apache',
    });
  });

  it('fails with INTERNAL when the services are not wired', async () => {
    const { router } = buildHarness({ withTools: false });
    expectError(await router.handle('tools.list', undefined), 'INTERNAL');
  });

  it('reads the tools preference from settings, and uses auto while locked', async () => {
    const harness = buildHarness();
    const { router, tools } = harness;
    expectValue(await router.handle('tools.list', undefined));
    await unlockWithProfile(harness);
    expectValue(await router.handle('settings.update', { mongoToolsVersion: VERSION }));
    expectValue(await router.handle('tools.list', undefined));
    expect(tools.listCalls).toEqual(['auto', VERSION]);
  });

  it('refuses a backup into a folder that was not picked, and writes into the real folder', async () => {
    const harness = buildHarness();
    const { router, tools } = harness;
    const connectionId = await unlockWithProfile(harness);
    const folder = join(dir, 'out');
    mkdirSync(folder);
    const link = join(dir, 'link');
    symlinkSync(folder, link);

    expectError(
      await router.handle('backup.start', startInput(connectionId, folder)),
      'VALIDATION',
    );
    expect(tools.backups.startDump).not.toHaveBeenCalled();

    await pick(harness, link, true);
    expectValue(await router.handle('backup.start', startInput(connectionId, link)));
    expect(tools.backups.startDump).toHaveBeenCalledWith(expect.objectContaining({ folder }));
    expect(tools.wiring?.isPickedFolder(link)).toBe(true);
    expect(tools.wiring?.isPickedFolder(dir)).toBe(false);
  });

  it('inspects only picked sources and maps a picked sidecar to its backup', async () => {
    const harness = buildHarness();
    const { router, tools } = harness;
    const archive = join(dir, 'shop.archive.gz');
    writeFileSync(archive, 'archive');
    writeFileSync(`${archive}.json`, '{}');
    const dump = join(dir, 'dump');
    mkdirSync(dump);
    writeFileSync(join(dump, 'mongo-gui-backup.json'), '{}');

    expectError(await router.handle('backup.inspect', { path: archive }), 'VALIDATION');
    expectError(await router.handle('backup.inspect', { path: dump }), 'VALIDATION');

    await pick(harness, `${archive}.json`, false);
    expect(
      expectValue(await router.handle('backup.inspect', { path: `${archive}.json` })),
    ).toMatchObject({ path: archive });
    await pick(harness, join(dump, 'mongo-gui-backup.json'), false);
    expectValue(
      await router.handle('backup.inspect', { path: join(dump, 'mongo-gui-backup.json') }),
    );
    expect(tools.inspect).toHaveBeenLastCalledWith(dump);
  });

  it('restores only an inspected source, until the renderer resets', async () => {
    const harness = buildHarness();
    const { router, tools } = harness;
    const connectionId = await unlockWithProfile(harness);
    const archive = join(dir, 'shop.archive.gz');
    writeFileSync(archive, 'archive');

    expectError(
      await router.handle('backup.startRestore', restoreInput(connectionId, archive)),
      'VALIDATION',
    );
    await pick(harness, archive, false);
    expectValue(await router.handle('backup.inspect', { path: archive }));
    expectValue(await router.handle('backup.startRestore', restoreInput(connectionId, archive)));
    expect(tools.backups.startRestore).toHaveBeenCalledTimes(1);

    router.resetRenderer();
    expect(tools.backups.cancelAll).toHaveBeenCalled();
    expect(tools.downloads.cancelAll).toHaveBeenCalled();
    expectError(
      await router.handle('backup.startRestore', restoreInput(connectionId, archive)),
      'VALIDATION',
    );
  });

  it('saves only an inspected source and reopens it for a restore after a renderer reset', async () => {
    const harness = buildHarness();
    const { router, tools } = harness;
    const connectionId = await unlockWithProfile(harness);
    const archive = join(dir, 'shop.archive.gz');
    writeFileSync(archive, 'archive');
    const { source, toolsVersion, options } = restoreInput(connectionId, archive);
    const input = { name: 'Nightly', connectionId, source, toolsVersion, options };

    expectError(await router.handle('savedRestores.save', input), 'VALIDATION');
    await pick(harness, archive, false);
    expectValue(await router.handle('backup.inspect', { path: archive }));
    const saved = expectValue(await router.handle('savedRestores.save', input)) as { id: string };
    expect(expectValue(await router.handle('savedRestores.list', undefined))).toEqual([saved]);
    expectValue(await router.handle('savedRestores.rename', { id: saved.id, name: 'Weekly' }));

    router.resetRenderer();
    expectError(
      await router.handle('backup.startRestore', restoreInput(connectionId, archive)),
      'VALIDATION',
    );
    expect(expectValue(await router.handle('savedRestores.open', { id: saved.id }))).toMatchObject({
      path: archive,
    });
    expectValue(await router.handle('backup.startRestore', restoreInput(connectionId, archive)));

    tools.inspect.mockRejectedValueOnce(
      new AppErrorException(appError('NOT_FOUND', 'The backup was not found.')),
    );
    expectError(await router.handle('savedRestores.open', { id: saved.id }), 'NOT_FOUND');
    expectValue(await router.handle('savedRestores.remove', { id: saved.id }));
    expectError(await router.handle('savedRestores.open', { id: saved.id }), 'NOT_FOUND');
  });

  it('reveals a file a backup wrote and refuses other paths', async () => {
    const harness = buildHarness();
    const { router, tools, shown } = harness;
    const written = join(dir, 'shop.archive.gz');
    expectError(await router.handle('app.showItemInFolder', { path: written }), 'VALIDATION');
    tools.backups.wroteFile.mockImplementation((path: string) => path === written);
    expectValue(await router.handle('app.showItemInFolder', { path: written }));
    expect(shown).toEqual([written]);
  });

  it('cancels the jobs of a connection that drops, and every job on lock', async () => {
    const harness = buildHarness();
    const { router, tools, connections } = harness;
    const connectionId = await unlockWithProfile(harness);

    connections.emitStatus(connectionId, CONNECTED);
    expect(tools.backups.cancelConnection).not.toHaveBeenCalled();
    connections.emitStatus(connectionId, { state: 'disconnected' });
    expect(tools.backups.cancelConnection).toHaveBeenCalledWith(connectionId);

    expect(tools.backups.cancelAll).not.toHaveBeenCalled();
    expectValue(await router.handle('vault.lock', undefined));
    expect(tools.backups.cancelAll).toHaveBeenCalledTimes(1);
    // Downloads do not need the store, so they go on.
    expect(tools.downloads.cancelAll).not.toHaveBeenCalled();
    expectError(await router.handle('backup.describeServer', { connectionId }), 'VAULT_LOCKED');
  });

  it('passes a failure from the services through with its code', async () => {
    const harness = buildHarness();
    const { router, tools } = harness;
    tools.downloads.start.mockRejectedValueOnce(
      new AppErrorException(appError('ALREADY_EXISTS', 'A download is running.')),
    );
    expectError(await router.handle('tools.download', { version: VERSION }), 'ALREADY_EXISTS');
  });
});
