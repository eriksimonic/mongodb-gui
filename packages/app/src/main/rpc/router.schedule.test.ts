import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { FIRST_CHECK_DELAY_MS, type UpdaterBackend } from '../updates/updater';
import { createAppServices, createRouter, type AppServices } from './router';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';

describe('the first scheduled check when the app starts locked', () => {
  let dir: string;
  let services: AppServices | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'schedule-'));
  });

  afterEach(async () => {
    await services?.dispose();
    services = undefined;
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('runs once the vault is set up, after start was called while locked', async () => {
    const checkForUpdates: Mock<() => Promise<unknown>> = vi.fn(() => Promise.resolve(null));
    const backend: UpdaterBackend = {
      autoDownload: true,
      autoInstallOnAppQuit: false,
      allowPrerelease: true,
      logger: null,
      checkForUpdates,
      downloadUpdate: () => Promise.resolve([]),
      quitAndInstall: () => undefined,
      on: () => backend,
    };
    services = createAppServices({
      userDataDir: dir,
      kdf: FAST_KDF,
      failureDelayMs: 0,
      updates: { autoUpdater: backend, platform: 'linux', isPackaged: true, appVersion: '0.1.0' },
    });
    const router = createRouter({ ...services, onEvent: () => undefined });

    services.updates.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS * 3);
    expect(checkForUpdates).not.toHaveBeenCalled();

    const init = await router.handle('vault.initialise', { password: PASSWORD });
    expect(init.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });
});
