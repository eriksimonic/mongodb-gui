import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  AppErrorException,
  appError,
  type AppError,
  type RpcEvent,
  type RpcResult,
  type UpdateState,
} from '@mongo-gui/core';
import { CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, type UpdaterBackend } from '../updates/updater';
import {
  createAppServices,
  createRouter,
  type AppServices,
  type Router,
  type UpdatesService,
} from './router';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';
const GITHUB_LINK = 'https://github.com/eriksimonic/mongodb-gui/releases/tag/v0.2.0';

const IDLE: UpdateState = { phase: 'idle', current: '0.1.0', canInstall: true };

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

interface StubUpdates extends UpdatesService {
  readonly listeners: Set<(state: UpdateState) => void>;
  readonly check: Mock;
  readonly download: Mock;
  readonly install: Mock;
  readonly dismiss: Mock;
  readonly refreshSchedule: Mock;
}

/** An updater stand-in that answers with fixed states and records the calls. */
function stubUpdates(): StubUpdates {
  const listeners = new Set<(state: UpdateState) => void>();
  return {
    listeners,
    state: () => IDLE,
    start: () => undefined,
    stop: () => undefined,
    refreshSchedule: vi.fn(),
    check: vi.fn(() => Promise.resolve(IDLE)),
    download: vi.fn(() => Promise.resolve({ ...IDLE, phase: 'downloading' as const })),
    install: vi.fn(() => {
      throw new AppErrorException(
        appError('VALIDATION', 'No downloaded update is ready to install.'),
      );
    }),
    dismiss: vi.fn((version: string) => ({ ...IDLE, phase: 'idle' as const, current: version })),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

interface RouterHarness {
  readonly router: Router;
  readonly events: RpcEvent[];
  readonly openExternal: Mock<(url: string) => Promise<void>>;
  readonly updates: StubUpdates;
}

let scratch: string | undefined;
let services: AppServices | undefined;

afterEach(async () => {
  await services?.dispose();
  services = undefined;
  if (scratch !== undefined) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

/** A router over real services in a temporary profile, with the updater replaced by a stub. */
function buildRouter(options: { withUpdates?: boolean } = {}): RouterHarness {
  scratch = mkdtempSync(join(tmpdir(), 'router-updates-'));
  services = createAppServices({ userDataDir: scratch, kdf: FAST_KDF, failureDelayMs: 0 });
  const events: RpcEvent[] = [];
  const updates = stubUpdates();
  const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
  const router = createRouter({
    vault: services.vault,
    store: services.store,
    repos: services.repos,
    connections: services.connections,
    onEvent: (event) => {
      events.push(event);
    },
    openExternal,
    ...(options.withUpdates === false ? {} : { updates }),
  });
  return { router, events, openExternal, updates };
}

describe('updates calls', () => {
  it('returns the updater state and passes check, download and dismiss through', async () => {
    const { router, updates } = buildRouter();

    expect(expectValue(await router.handle('updates.state', undefined))).toEqual(IDLE);
    expect(expectValue(await router.handle('updates.check', undefined))).toEqual(IDLE);
    expect(updates.check).toHaveBeenCalledTimes(1);

    expect(expectValue(await router.handle('updates.download', undefined))).toMatchObject({
      phase: 'downloading',
    });
    expect(expectValue(await router.handle('updates.dismiss', { version: '0.2.0' }))).toMatchObject(
      { phase: 'idle', current: '0.2.0' },
    );
  });

  it('maps an install refusal to its AppError', async () => {
    const { router } = buildRouter();
    expectError(await router.handle('updates.install', undefined), 'VALIDATION');
  });

  it('rejects a dismiss without a version', async () => {
    const { router, updates } = buildRouter();
    expectError(await router.handle('updates.dismiss', {}), 'VALIDATION');
    expect(updates.dismiss).not.toHaveBeenCalled();
  });

  it('answers INTERNAL when no updater is wired', async () => {
    const { router } = buildRouter({ withUpdates: false });
    expectError(await router.handle('updates.state', undefined), 'INTERNAL');
  });

  it('forwards updater state changes as updates:state events', () => {
    const { events, updates } = buildRouter();
    updates.listeners.forEach((listener) => listener({ ...IDLE, phase: 'available' }));
    expect(events).toEqual([{ type: 'updates:state', state: { ...IDLE, phase: 'available' } }]);
  });
});

describe('app.openExternal', () => {
  it('opens a link to the project on GitHub', async () => {
    const { router, openExternal } = buildRouter();
    expectValue(await router.handle('app.openExternal', { url: GITHUB_LINK }));
    expect(openExternal).toHaveBeenCalledWith(new URL(GITHUB_LINK).href);
  });

  it('refuses links to other hosts, other repositories and path traversal', async () => {
    const { router, openExternal } = buildRouter();
    const refused = [
      'https://example.com/eriksimonic/mongodb-gui/releases',
      'http://github.com/eriksimonic/mongodb-gui/releases',
      'https://github.com/someone/else/releases',
      'https://github.com/eriksimonic/mongodb-gui/../other/releases',
      'file:///etc/passwd',
      'https://github.com/eriksimonic/mongodb-gui/%2e%2e/evil',
      'https://github.com/eriksimonic/mongodb-gui/%2e%2e%2fevil',
      'https://github.com/eriksimonic/mongodb-gui/../../evil',
      'https://github.com@evil.com/eriksimonic/mongodb-gui/releases',
      'https://mongodb-gui.evil.com/eriksimonic/mongodb-gui/releases',
      'javascript:alert(1)',
      'https://github.com/eriksimonic/mongodb-gui/releases\nhttps://evil.example',
      'https://github.com/eriksimonic/mongodb-gui/releases\r\nX-Injected: 1',
      'https://github.com/eriksimonic/mongodb-gui/releases now',
      'https://user:pass@github.com/eriksimonic/mongodb-gui/releases',
      'https://github.com:444/eriksimonic/mongodb-gui/releases',
    ];
    for (const url of refused) {
      expectError(await router.handle('app.openExternal', { url }), 'VALIDATION');
    }
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('createAppServices with an updater', () => {
  let dir: string;
  let services: AppServices | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'updates-'));
  });

  afterEach(async () => {
    await services?.dispose();
    services = undefined;
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function packagedBackend(): UpdaterBackend & { readonly checkForUpdates: Mock } {
    const backend: UpdaterBackend & { readonly checkForUpdates: Mock } = {
      autoDownload: true,
      autoInstallOnAppQuit: false,
      allowPrerelease: true,
      logger: null,
      checkForUpdates: vi.fn(() => Promise.resolve(null)),
      downloadUpdate: vi.fn(() => Promise.resolve([])),
      quitAndInstall: vi.fn(),
      on: () => backend,
    };
    return backend;
  }

  it('turns the schedule off when the setting is switched off and back on when it is switched on', async () => {
    const backend = packagedBackend();
    services = createAppServices({
      userDataDir: dir,
      kdf: FAST_KDF,
      failureDelayMs: 0,
      updates: { autoUpdater: backend, platform: 'linux', isPackaged: true, appVersion: '0.1.0' },
    });
    const router = createRouter({
      ...services,
      onEvent: () => undefined,
    });
    const states: UpdateState[] = [];
    services.updates.subscribe((state) => states.push(state));

    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
    // The idle lock would lock the vault during the twelve hours this test advances.
    expectValue(await router.handle('settings.update', { idleLockMinutes: 24 * 60 }));
    services.updates.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1);

    expectValue(await router.handle('settings.update', { checkForUpdates: false }));
    expect(services.updates.state().phase).toBe('disabled');
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1);

    expectValue(await router.handle('settings.update', { checkForUpdates: true }));
    expect(services.updates.state().phase).toBe('idle');
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(states.map((state) => state.phase)).toContain('disabled');
  });

  it('keeps the setting off after a restart, and does not check until the vault unlocks', async () => {
    const backend = packagedBackend();
    const first = createAppServices({
      userDataDir: dir,
      kdf: FAST_KDF,
      failureDelayMs: 0,
      updates: { autoUpdater: backend, platform: 'linux', isPackaged: true, appVersion: '0.1.0' },
    });
    const firstRouter = createRouter({ ...first, onEvent: () => undefined });
    expectValue(await firstRouter.handle('vault.initialise', { password: PASSWORD }));
    expectValue(await firstRouter.handle('settings.update', { checkForUpdates: false }));
    await first.dispose();

    services = createAppServices({
      userDataDir: dir,
      kdf: FAST_KDF,
      failureDelayMs: 0,
      updates: { autoUpdater: backend, platform: 'linux', isPackaged: true, appVersion: '0.1.0' },
    });
    services.updates.start();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    // The vault is locked after a restart, so the setting cannot be read and nothing runs.
    expect(backend.checkForUpdates).not.toHaveBeenCalled();
    expect(services.updates.state().phase).toBe('idle');
  });
});
