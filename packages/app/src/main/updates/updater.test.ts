import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { UpdateState } from '@mongo-gui/core';
import { createLogger, type Logger } from '../log';
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  canInstallUpdates,
  createUpdater,
  type Updater,
  type UpdaterBackend,
  type UpdaterListeners,
} from './updater';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const STAMP = NOW.toISOString();
const RELEASE_URL = 'https://github.com/eriksimonic/mongodb-mager/releases/tag/v0.2.0';

interface FakeBackend extends UpdaterBackend {
  emit(event: keyof UpdaterListeners, ...args: unknown[]): void;
  checkForUpdates: Mock<() => Promise<unknown>>;
  downloadUpdate: Mock<() => Promise<unknown>>;
  quitAndInstall: Mock<(isSilent?: boolean, isForceRunAfter?: boolean) => void>;
}

/** An autoUpdater stand-in: the same method names, with events the test emits by hand. */
function fakeBackend(): FakeBackend {
  const emitter = new EventEmitter();
  const backend: FakeBackend = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
    logger: null,
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    downloadUpdate: vi.fn(() => Promise.resolve([])),
    quitAndInstall: vi.fn(),
    on<E extends keyof UpdaterListeners>(event: E, listener: UpdaterListeners[E]) {
      emitter.on(event, listener);
      return backend;
    },
    emit(event, ...args) {
      emitter.emit(event, ...args);
    },
  };
  return backend;
}

interface Harness {
  readonly updater: Updater;
  readonly backend: FakeBackend;
  readonly states: UpdateState[];
  readonly log: { info: Mock; warn: Mock; error: Mock };
  readonly setting: { value: boolean | undefined };
}

interface HarnessOptions {
  readonly logger?: Logger;
  readonly isPackaged?: boolean;
  readonly platform?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly enabled?: boolean | undefined;
}

function harness(options: HarnessOptions = {}): Harness {
  const backend = fakeBackend();
  const states: UpdateState[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const setting: { value: boolean | undefined } = {
    value: options.enabled === undefined ? true : options.enabled,
  };
  const updater = createUpdater({
    log: options.logger ?? log,
    settings: { readCheckForUpdates: () => setting.value },
    onState: (state) => {
      states.push(state);
    },
    autoUpdater: backend,
    platform: options.platform ?? 'linux',
    isPackaged: options.isPackaged ?? true,
    appVersion: '0.1.0',
    env: options.env ?? { APPIMAGE: '/opt/Mongo GUI.AppImage' },
    now: () => NOW,
  });
  return { updater, backend, states, log, setting };
}

function latest(states: readonly UpdateState[]): UpdateState {
  const last = states.at(-1);
  if (last === undefined) {
    throw new Error('no state was published');
  }
  return last;
}

function availableInfo(version = '0.2.0') {
  return { version, releaseDate: '2026-10-08T09:00:00.000Z' };
}

describe('canInstallUpdates', () => {
  it('is true on an AppImage launch and false for a deb install', () => {
    expect(canInstallUpdates('linux', { APPIMAGE: '/opt/app.AppImage' })).toBe(true);
    expect(canInstallUpdates('linux', { APPIMAGE: '' })).toBe(false);
    expect(canInstallUpdates('linux', {})).toBe(false);
  });

  it('is true on Windows and false on macOS', () => {
    expect(canInstallUpdates('win32', {})).toBe(true);
    expect(canInstallUpdates('darwin', {})).toBe(false);
  });
});

describe('createUpdater in a development build', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the dev phase and never contacts GitHub', async () => {
    const { updater, backend } = harness({ isPackaged: false });
    updater.start();
    expect(updater.state().phase).toBe('dev');
    await updater.check();
    await expect(updater.download()).resolves.toMatchObject({ phase: 'dev' });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(backend.checkForUpdates).not.toHaveBeenCalled();
    expect(backend.downloadUpdate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never attaches listeners or changes the backend configuration', () => {
    const { backend } = harness({ isPackaged: false });
    expect(backend.autoDownload).toBe(true);
    expect(backend.logger).toBeNull();
  });

  it('refuses install', () => {
    const { updater, backend } = harness({ isPackaged: false });
    expect(() => updater.install()).toThrow('development build');
    expect(backend.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe('createUpdater configuration', () => {
  it('turns off automatic download and enables install on quit only where installable', () => {
    const installable = harness({ platform: 'linux', env: { APPIMAGE: '/a.AppImage' } });
    expect(installable.backend.autoDownload).toBe(false);
    expect(installable.backend.autoInstallOnAppQuit).toBe(true);
    expect(installable.backend.allowPrerelease).toBe(false);

    const deb = harness({ platform: 'linux', env: {} });
    expect(deb.backend.autoInstallOnAppQuit).toBe(false);
  });

  it('reports canInstall per platform', () => {
    const win = harness({ platform: 'win32' }).updater.state();
    expect(win.canInstall).toBe(true);
    expect(harness({ platform: 'darwin' }).updater.state().canInstall).toBe(false);
    expect(harness({ platform: 'linux', env: {} }).updater.state().canInstall).toBe(false);
  });

  it('starts idle, or disabled when the setting is off, or idle while the vault is locked', () => {
    expect(harness().updater.state().phase).toBe('idle');
    expect(harness({ enabled: false }).updater.state().phase).toBe('disabled');
    expect(harness({ enabled: undefined }).updater.state().phase).toBe('idle');
  });

  it('routes electron-updater log lines to the app log, which redacts them', () => {
    const lines: string[] = [];
    const { backend } = harness({ logger: createLogger((line) => lines.push(line)) });
    backend.logger?.info('connecting to mongodb://app:hunter2@db.example.net/');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('mongodb://app:***@db.example.net/');
    expect(lines[0]).not.toContain('hunter2');
  });
});

describe('scheduled checks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the first check ten seconds after start and then every six hours', async () => {
    const { updater, backend } = harness();
    updater.start();
    expect(backend.checkForUpdates).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(backend.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('does not schedule anything before start', async () => {
    const { backend } = harness();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(backend.checkForUpdates).not.toHaveBeenCalled();
  });

  it('stops when the setting is turned off and restarts when it is turned on', async () => {
    const { updater, backend, setting, states } = harness();
    updater.start();
    setting.value = false;
    updater.refreshSchedule();
    expect(latest(states).phase).toBe('disabled');

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(backend.checkForUpdates).not.toHaveBeenCalled();

    setting.value = true;
    updater.refreshSchedule();
    expect(latest(states).phase).toBe('idle');
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('clears the schedule while the vault is locked', async () => {
    const { updater, backend, setting } = harness();
    updater.start();
    setting.value = undefined;
    updater.refreshSchedule();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(backend.checkForUpdates).not.toHaveBeenCalled();
  });

  it('does not schedule a second timer when refreshed with the setting still on', async () => {
    const { updater, backend } = harness();
    updater.start();
    updater.refreshSchedule();
    updater.refreshSchedule();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('keeps checking after a failed scheduled check and logs it at info level', async () => {
    const { updater, backend, log, states } = harness();
    backend.checkForUpdates.mockImplementation(() => {
      backend.emit('error', new Error('getaddrinfo ENOTFOUND github.com'));
      return Promise.reject(new Error('getaddrinfo ENOTFOUND github.com'));
    });
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(log.info).toHaveBeenCalledWith(
      'update check failed, the next check is scheduled',
      expect.objectContaining({ error: 'getaddrinfo ENOTFOUND github.com' }),
    );
    expect(log.warn).not.toHaveBeenCalled();
    expect(updater.state().phase).toBe('idle');
    expect(updater.state().error).toBeUndefined();
    expect(states).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});

describe('phase transitions', () => {
  it('moves from checking to available with the release page link', async () => {
    const { updater, backend, states } = harness({ env: { APPIMAGE: '/a.AppImage' } });
    backend.checkForUpdates.mockImplementation(() => {
      backend.emit('checking-for-update');
      backend.emit('update-available', {
        ...availableInfo(),
        releaseNotes: [{ note: 'First line' }, { note: null }, { note: 'Second line' }],
      });
      return Promise.resolve(null);
    });
    const result = await updater.check();

    expect(states.map((state) => state.phase)).toEqual(['checking', 'available']);
    expect(result.phase).toBe('available');
    expect(result.available).toEqual({
      version: '0.2.0',
      releaseDate: '2026-10-08T09:00:00.000Z',
      notes: 'First line\n\nSecond line',
      downloadUrl: RELEASE_URL,
    });
    expect(result.lastCheckedAt).toBe(STAMP);
    expect(result.canInstall).toBe(true);
  });

  it('uses notify-only instead of available where installing is not possible', async () => {
    const { updater, backend } = harness({ platform: 'linux', env: {} });
    backend.checkForUpdates.mockImplementation(() => {
      backend.emit('update-available', availableInfo());
      return Promise.resolve(null);
    });
    const result = await updater.check();
    expect(result.phase).toBe('notify-only');
    expect(result.available?.downloadUrl).toBe(RELEASE_URL);
    expect(result.canInstall).toBe(false);
  });

  it('returns to idle with a timestamp when no update is available', async () => {
    const { updater, backend } = harness();
    backend.checkForUpdates.mockImplementation(() => {
      backend.emit('update-not-available', { version: '0.1.0' });
      return Promise.resolve(null);
    });
    const result = await updater.check();
    expect(result).toMatchObject({ phase: 'idle', lastCheckedAt: STAMP });
    expect(result.available).toBeUndefined();
  });

  it('downloads only when asked, then reports progress, downloaded and install', async () => {
    const { updater, backend, states } = harness({ env: { APPIMAGE: '/a.AppImage' } });
    backend.checkForUpdates.mockImplementation(() => {
      backend.emit('update-available', availableInfo());
      return Promise.resolve(null);
    });
    await updater.check();
    expect(backend.downloadUpdate).not.toHaveBeenCalled();

    const started = await updater.download();
    expect(started).toMatchObject({ phase: 'downloading', progress: { percent: 0 } });
    expect(backend.downloadUpdate).toHaveBeenCalledTimes(1);

    backend.emit('download-progress', {
      percent: 42.5,
      bytesPerSecond: 1024,
      transferred: 10,
      total: 24,
    });
    expect(latest(states)).toMatchObject({
      phase: 'downloading',
      progress: { percent: 42.5, bytesPerSecond: 1024, transferred: 10, total: 24 },
    });

    backend.emit('update-downloaded', availableInfo());
    expect(latest(states)).toMatchObject({ phase: 'downloaded', available: { version: '0.2.0' } });

    updater.install();
    expect(backend.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('refuses to download when the update cannot be installed', async () => {
    const { updater, backend } = harness({ env: {} });
    backend.checkForUpdates.mockImplementation(() => {
      backend.emit('update-available', availableInfo());
      return Promise.resolve(null);
    });
    await updater.check();
    await expect(updater.download()).rejects.toMatchObject({
      error: { code: 'VALIDATION' },
    });
    expect(backend.downloadUpdate).not.toHaveBeenCalled();
  });

  it('refuses to install when nothing is downloaded', () => {
    const { updater, backend } = harness();
    expect(() => updater.install()).toThrow('No downloaded update is ready to install.');
    expect(backend.quitAndInstall).not.toHaveBeenCalled();
  });

  it('shows a download error with the redacted detail', async () => {
    const { updater, backend, log } = harness({ env: { APPIMAGE: '/a.AppImage' } });
    backend.checkForUpdates.mockImplementation(() => {
      backend.emit('update-available', availableInfo());
      return Promise.resolve(null);
    });
    await updater.check();
    backend.downloadUpdate.mockImplementation(() => {
      backend.emit('download-progress', { percent: 3 });
      backend.emit('error', new Error('socket hang up at mongodb://ops:topsecret@db.example.net'));
      return Promise.reject(new Error('socket hang up'));
    });
    await updater.download();
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalled());

    const state = updater.state();
    expect(state.phase).toBe('error');
    expect(state.error?.message).toBe('Could not download the update.');
    expect(state.error?.detail).toContain('***');
    expect(state.error?.detail).not.toContain('topsecret');
  });

  it('does not restart a download that is already running or finished', async () => {
    const { updater, backend } = harness({ env: { APPIMAGE: '/a.AppImage' } });
    backend.checkForUpdates.mockImplementation(() => {
      backend.emit('update-available', availableInfo());
      return Promise.resolve(null);
    });
    await updater.check();
    await updater.download();
    await updater.download();
    expect(backend.downloadUpdate).toHaveBeenCalledTimes(1);

    backend.emit('update-downloaded', availableInfo());
    await updater.download();
    expect(backend.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not check again while an update is downloaded', async () => {
    const { updater, backend } = harness({ env: { APPIMAGE: '/a.AppImage' } });
    backend.checkForUpdates.mockImplementation(() => {
      backend.emit('update-available', availableInfo());
      return Promise.resolve(null);
    });
    await updater.check();
    await updater.download();
    backend.emit('update-downloaded', availableInfo());
    await updater.check();
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('keeps the downloaded state when a check finds the same version again', async () => {
    const { updater, backend, states } = harness({ env: { APPIMAGE: '/a.AppImage' } });
    backend.checkForUpdates.mockImplementation(() => {
      backend.emit('update-available', availableInfo());
      return Promise.resolve(null);
    });
    await updater.check();
    await updater.download();
    backend.emit('update-downloaded', availableInfo());
    backend.emit('update-available', availableInfo());
    expect(latest(states).phase).toBe('downloaded');
  });
});

describe('manual check errors', () => {
  it('shows a compact error with the redacted detail', async () => {
    const { updater, backend, log } = harness();
    backend.checkForUpdates.mockImplementation(() => {
      backend.emit('error', new Error('connect failed for mongodb://app:hunter2@localhost/'));
      return Promise.reject(new Error('connect failed'));
    });
    const result = await updater.check();

    expect(result.phase).toBe('error');
    expect(result.error).toEqual({
      code: 'INTERNAL',
      message: 'Could not check for updates.',
      detail: 'connect failed for mongodb://app:***@localhost/',
    });
    expect(log.warn).toHaveBeenCalledWith('update check failed', expect.any(Object));
  });

  it('handles a rejection that arrives without an error event', async () => {
    const { updater, backend } = harness();
    backend.checkForUpdates.mockRejectedValue(new Error('timed out'));
    const result = await updater.check();
    expect(result.phase).toBe('error');
    expect(result.error?.detail).toBe('timed out');
  });

  it('treats a repository without a published release as up to date', async () => {
    const { updater, backend, log } = harness();
    backend.checkForUpdates.mockImplementation(() => {
      const error = Object.assign(new Error('No published versions on GitHub'), {
        code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
      });
      backend.emit('error', error);
      return Promise.reject(error);
    });
    const result = await updater.check();
    expect(result).toMatchObject({ phase: 'idle', lastCheckedAt: STAMP });
    expect(result.error).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('treats the feed parser error for an empty release feed as up to date', async () => {
    const { updater, backend, log } = harness();
    backend.checkForUpdates.mockImplementation(() => {
      // electron-updater throws a plain Error here, with no code.
      const error = new Error('No published versions on GitHub');
      backend.emit('error', error);
      return Promise.reject(error);
    });
    const result = await updater.check();
    expect(result).toMatchObject({ phase: 'idle', lastCheckedAt: STAMP });
    expect(result.error).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('treats a 404 from the release feed as up to date', async () => {
    const { updater, backend } = harness();
    backend.checkForUpdates.mockImplementation(() => {
      const error = Object.assign(new Error('Not Found'), { statusCode: 404 });
      backend.emit('error', error);
      return Promise.reject(error);
    });
    const result = await updater.check();
    expect(result).toMatchObject({ phase: 'idle', lastCheckedAt: STAMP });
  });

  it('keeps a missing channel file as an error', async () => {
    const { updater, backend } = harness();
    backend.checkForUpdates.mockImplementation(() => {
      const error = Object.assign(new Error('Cannot find latest-linux.yml'), {
        code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
        statusCode: 404,
      });
      backend.emit('error', error);
      return Promise.reject(error);
    });
    const result = await updater.check();
    expect(result.phase).toBe('error');
  });

  it('rejects a version string that could build an unexpected link', async () => {
    const { updater, backend } = harness();
    backend.checkForUpdates.mockImplementation(() => {
      backend.emit('update-available', { version: '0.2.0/../../x' });
      return Promise.resolve(null);
    });
    const result = await updater.check();
    expect(result.phase).toBe('error');
    expect(result.available).toBeUndefined();
  });
});

describe('dismiss', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hides the notice for that version, but a manual check shows it again', async () => {
    const { updater, backend } = harness({ env: { APPIMAGE: '/a.AppImage' } });
    backend.checkForUpdates.mockImplementation(() => {
      backend.emit('update-available', availableInfo());
      return Promise.resolve(null);
    });
    await updater.check();

    const dismissed = updater.dismiss('0.2.0');
    expect(dismissed.phase).toBe('idle');
    expect(dismissed.available).toBeUndefined();

    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(updater.state().phase).toBe('idle');

    const manual = await updater.check();
    expect(manual.phase).toBe('available');
  });

  it('ignores a version that is not the one on offer', async () => {
    const { updater, backend } = harness({ env: { APPIMAGE: '/a.AppImage' } });
    backend.checkForUpdates.mockImplementation(() => {
      backend.emit('update-available', availableInfo());
      return Promise.resolve(null);
    });
    await updater.check();
    expect(updater.dismiss('9.9.9').phase).toBe('available');
  });
});

describe('refreshSchedule during a download', () => {
  it('keeps a downloading update when the setting is switched off', async () => {
    const { updater, backend, setting } = harness({ env: { APPIMAGE: '/a.AppImage' } });
    backend.checkForUpdates.mockImplementation(() => {
      backend.emit('update-available', availableInfo());
      return Promise.resolve(null);
    });
    await updater.check();
    await updater.download();
    setting.value = false;
    updater.refreshSchedule();
    expect(updater.state().phase).toBe('downloading');
  });
});
