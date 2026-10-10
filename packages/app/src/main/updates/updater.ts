import {
  AppErrorException,
  appError,
  toAppError,
  type AppError,
  type UpdateAvailable,
  type UpdatePhase,
  type UpdateProgress,
  type UpdateState,
} from '@mongo-gui/core';
import type { Logger } from '../log';
import { redactText } from '../redact';

export const FIRST_CHECK_DELAY_MS = 10_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const RELEASE_PAGE_PREFIX = 'https://github.com/eriksimonic/mongodb-gui/releases/tag/';

const NO_PUBLISHED_RELEASE = 'ERR_UPDATER_NO_PUBLISHED_VERSIONS';
const NO_PUBLISHED_RELEASE_MESSAGE = 'No published versions on GitHub';
const CHANNEL_FILE_MISSING = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The fields of electron-updater's UpdateInfo that this module reads. */
export interface UpdaterInfo {
  readonly version: string;
  readonly releaseDate?: string | null | undefined;
  readonly releaseNotes?: string | readonly { readonly note: string | null }[] | null | undefined;
}

export interface UpdaterProgressInfo {
  readonly percent: number;
  readonly bytesPerSecond?: number | undefined;
  readonly transferred?: number | undefined;
  readonly total?: number | undefined;
}

export interface UpdaterListeners {
  'checking-for-update': () => void;
  'update-available': (info: UpdaterInfo) => void;
  'update-not-available': (info: UpdaterInfo) => void;
  'download-progress': (info: UpdaterProgressInfo) => void;
  'update-downloaded': (info: UpdaterInfo) => void;
  error: (error: Error, message?: string) => void;
}

export interface UpdaterLogger {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
}

/**
 * The part of electron-updater's autoUpdater this module uses. The real singleton satisfies
 * it, and tests pass a fake with the same method names.
 */
export interface UpdaterBackend {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  logger: UpdaterLogger | null;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'checking-for-update', listener: UpdaterListeners['checking-for-update']): unknown;
  on(event: 'update-available', listener: UpdaterListeners['update-available']): unknown;
  on(event: 'update-not-available', listener: UpdaterListeners['update-not-available']): unknown;
  on(event: 'download-progress', listener: UpdaterListeners['download-progress']): unknown;
  on(event: 'update-downloaded', listener: UpdaterListeners['update-downloaded']): unknown;
  on(event: 'error', listener: UpdaterListeners['error']): unknown;
}

/**
 * Reads the saved setting. Returns undefined while the vault is locked, because the
 * settings live in the encrypted store.
 */
export interface UpdaterSettings {
  readCheckForUpdates(): boolean | undefined;
}

export interface UpdaterOptions {
  readonly log: Logger;
  readonly settings: UpdaterSettings;
  readonly onState: (state: UpdateState) => void;
  readonly autoUpdater: UpdaterBackend;
  readonly platform: string;
  readonly isPackaged: boolean;
  readonly appVersion: string;
  /** Defaults to process.env. Only APPIMAGE is read. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to the system clock. Tests inject one. */
  readonly now?: () => Date;
}

export interface Updater {
  state(): UpdateState;
  /** Arms the first check. Checks run only while the saved setting is on. */
  start(): void;
  /** Stops every timer. Used on quit. */
  stop(): void;
  /** Re-reads the saved setting and arms, moves or clears the schedule. */
  refreshSchedule(): void;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  /** Quits and installs a downloaded update. Throws when nothing is downloaded. */
  install(): void;
  dismiss(version: string): UpdateState;
}

interface Parts {
  phase: UpdatePhase;
  available?: UpdateAvailable | undefined;
  progress?: UpdateProgress | undefined;
  error?: AppError | undefined;
  lastCheckedAt?: string | undefined;
}

/** Whether electron-updater can replace the running app on this platform and install. */
export function canInstallUpdates(
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (platform === 'linux') {
    const appImage = env['APPIMAGE'];
    return appImage !== undefined && appImage !== '';
  }
  // The Windows target is NSIS, which electron-updater can replace in place.
  return platform === 'win32';
}

/**
 * Creates the update service. In a development build it does nothing and never touches
 * autoUpdater, so `pnpm dev` never contacts GitHub.
 */
export function createUpdater(options: UpdaterOptions): Updater {
  const { log, settings, autoUpdater, isPackaged, appVersion } = options;
  const now = options.now ?? (() => new Date());
  const canInstall = canInstallUpdates(options.platform, options.env ?? process.env);

  let parts: Parts = { phase: isPackaged ? initialPhase() : 'dev' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let manualCheck = false;
  let checkOutcomes = 0;
  let dismissedVersion: string | undefined;

  function initialPhase(): UpdatePhase {
    return settings.readCheckForUpdates() === false ? 'disabled' : 'idle';
  }

  function current(): UpdateState {
    return { ...parts, current: appVersion, canInstall };
  }

  function publish(next: Parts): void {
    parts = next;
    options.onState(current());
  }

  /** The phase change keeps the last check time, which every phase shows. */
  function only(phase: UpdatePhase): Parts {
    return { phase, lastCheckedAt: parts.lastCheckedAt };
  }

  function markUpToDate(): void {
    if (parts.phase === 'downloading' || parts.phase === 'downloaded') {
      return;
    }
    publish({ phase: 'idle', lastCheckedAt: now().toISOString() });
  }

  function handleAvailable(info: UpdaterInfo): void {
    const stamp = now().toISOString();
    const available = availableFrom(info);
    if (available === undefined) {
      publish({ phase: 'error', error: unexpectedVersionError(), lastCheckedAt: stamp });
      log.warn('update check returned an unexpected version');
      return;
    }
    if (parts.phase === 'downloading' || parts.phase === 'downloaded') {
      // A check that runs while an update is already downloading or downloaded must not reset that state.
      publish({ ...parts, lastCheckedAt: stamp });
      return;
    }
    if (!manualCheck && dismissedVersion === available.version) {
      publish({ phase: 'idle', lastCheckedAt: stamp });
      return;
    }
    publish({ phase: canInstall ? 'available' : 'notify-only', available, lastCheckedAt: stamp });
  }

  function handleError(error: unknown): void {
    checkOutcomes += 1;
    if (isNoPublishedRelease(error)) {
      // A repository without a published release is up to date, not broken.
      markUpToDate();
      return;
    }
    const detail = redactText(toAppError(error).message);
    if (parts.phase === 'downloading') {
      // The offer stays, so Retry can download again instead of checking.
      publish({
        ...only('error'),
        ...(parts.available === undefined ? {} : { available: parts.available }),
        error: appError('INTERNAL', 'Could not download the update.', detail),
      });
      log.warn('update download failed', { error: detail });
      return;
    }
    if (manualCheck) {
      publish({
        ...only('error'),
        error: appError('INTERNAL', 'Could not check for updates.', detail),
      });
      log.warn('update check failed', { error: detail });
      return;
    }
    // A scheduled check that fails, usually because the machine is offline, is not shown.
    log.info('update check failed, the next check is scheduled', { error: detail });
    if (parts.phase === 'checking') {
      publish(only('idle'));
    }
  }

  function wireListeners(): void {
    autoUpdater.on('checking-for-update', () => {
      if (parts.phase === 'idle' || parts.phase === 'error') {
        publish(only('checking'));
      }
    });
    autoUpdater.on('update-available', (info) => {
      checkOutcomes += 1;
      handleAvailable(info);
    });
    autoUpdater.on('update-not-available', () => {
      checkOutcomes += 1;
      markUpToDate();
    });
    autoUpdater.on('download-progress', (info) => {
      publish({ ...parts, phase: 'downloading', progress: progressOf(info) });
    });
    autoUpdater.on('update-downloaded', (info) => {
      const available = parts.available ?? availableFrom(info);
      publish({ ...only('downloaded'), available });
    });
    autoUpdater.on('error', (error) => {
      handleError(error);
    });
  }

  if (isPackaged) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = canInstall;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = updaterLogger(log);
    wireListeners();
  }

  async function runCheck(manual: boolean): Promise<void> {
    manualCheck = manual;
    const before = checkOutcomes;
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      // electron-updater emits the error event before it rejects. This handles only a
      // rejection that arrived without an event.
      if (checkOutcomes === before) {
        handleError(error);
      }
    } finally {
      manualCheck = false;
    }
  }

  function canCheck(): boolean {
    return (
      isPackaged &&
      parts.phase !== 'disabled' &&
      parts.phase !== 'downloading' &&
      parts.phase !== 'downloaded'
    );
  }

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function schedule(delayMs: number): void {
    clearTimer();
    if (!started || !isPackaged) {
      return;
    }
    const next = setTimeout(() => {
      timer = undefined;
      void runScheduled();
    }, delayMs);
    next.unref();
    timer = next;
  }

  async function runScheduled(): Promise<void> {
    if (settings.readCheckForUpdates() !== true) {
      clearTimer();
      return;
    }
    if (canCheck()) {
      await runCheck(false);
    }
    if (settings.readCheckForUpdates() === true) {
      schedule(CHECK_INTERVAL_MS);
    }
  }

  return {
    state: current,

    start() {
      if (started) {
        return;
      }
      started = true;
      if (isPackaged && settings.readCheckForUpdates() === true) {
        schedule(FIRST_CHECK_DELAY_MS);
      }
    },

    stop() {
      started = false;
      clearTimer();
    },

    refreshSchedule() {
      if (!isPackaged) {
        return;
      }
      const enabled = settings.readCheckForUpdates();
      if (enabled === undefined) {
        clearTimer();
        return;
      }
      if (!enabled) {
        clearTimer();
        if (parts.phase !== 'downloading' && parts.phase !== 'downloaded') {
          publish(only('disabled'));
        }
        return;
      }
      if (parts.phase === 'disabled') {
        publish(only('idle'));
      }
      if (timer === undefined) {
        schedule(FIRST_CHECK_DELAY_MS);
      }
    },

    async check() {
      // An unknown setting (locked vault) or a switched-off setting means no request to GitHub.
      if (canCheck() && settings.readCheckForUpdates() === true) {
        await runCheck(true);
      }
      return current();
    },

    async download() {
      if (!isPackaged) {
        return current();
      }
      if (parts.phase === 'downloading' || parts.phase === 'downloaded') {
        return current();
      }
      // A failed download keeps its offer in the error phase, so the user can try again.
      const offered =
        parts.phase === 'available' || (parts.phase === 'error' && parts.available !== undefined);
      if (!offered || !canInstall) {
        throw new AppErrorException(appError('VALIDATION', 'No update is ready to download.'));
      }
      publish({ ...parts, phase: 'downloading', progress: { percent: 0 }, error: undefined });
      autoUpdater.downloadUpdate().catch((error: unknown) => {
        // The error event usually handles the failure first. The phase check keeps it from running twice.
        if (parts.phase === 'downloading') {
          handleError(error);
        }
      });
      return current();
    },

    install() {
      if (!isPackaged) {
        throw new AppErrorException(
          appError('VALIDATION', 'Updates are not available in a development build.'),
        );
      }
      if (parts.phase !== 'downloaded') {
        throw new AppErrorException(
          appError('VALIDATION', 'No downloaded update is ready to install.'),
        );
      }
      autoUpdater.quitAndInstall(false, true);
    },

    dismiss(version) {
      const dismissible =
        parts.phase === 'available' ||
        parts.phase === 'notify-only' ||
        parts.phase === 'downloaded';
      if (!dismissible || parts.available?.version !== version) {
        return current();
      }
      dismissedVersion = version;
      publish(only('idle'));
      return current();
    },
  };
}

function availableFrom(info: UpdaterInfo): UpdateAvailable | undefined {
  if (!VERSION_PATTERN.test(info.version)) {
    return undefined;
  }
  const notes = notesText(info.releaseNotes);
  return {
    version: info.version,
    downloadUrl: `${RELEASE_PAGE_PREFIX}v${info.version}`,
    ...(info.releaseDate === undefined || info.releaseDate === null
      ? {}
      : { releaseDate: info.releaseDate }),
    ...(notes === undefined ? {} : { notes }),
  };
}

function notesText(notes: UpdaterInfo['releaseNotes']): string | undefined {
  if (typeof notes === 'string') {
    return plainText(notes);
  }
  if (Array.isArray(notes)) {
    return notes
      .map((entry) => plainText(entry.note ?? ''))
      .filter((text) => text !== '')
      .join('\n\n');
  }
  return undefined;
}

const LINE_BREAK = /<br\s*\/?>|<\/(?:p|li|h[1-6]|div|tr)>/gi;
const TAG = /<[^>]*>/g;
const ENTITY = /&(amp|lt|gt|quot|#39);/g;
const ENTITY_TEXT: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
};

/**
 * Turns release notes, which GitHub usually sends as HTML, into plain text. Block tags become line
 * breaks, other tags are dropped, and the five common entities are decoded in one pass, so
 * `&amp;lt;` shows as `&lt;` and not as `<`.
 */
export function plainText(html: string): string {
  return html
    .replace(LINE_BREAK, '\n')
    .replace(TAG, '')
    .replace(ENTITY, (_match, name: string) => ENTITY_TEXT[name] ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

function progressOf(info: UpdaterProgressInfo): UpdateProgress {
  return {
    percent: info.percent,
    bytesPerSecond: info.bytesPerSecond,
    transferred: info.transferred,
    total: info.total,
  };
}

function unexpectedVersionError(): AppError {
  return appError('INTERNAL', 'The update has an unexpected version number.');
}

function isNoPublishedRelease(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = 'code' in error ? error.code : undefined;
  if (code === NO_PUBLISHED_RELEASE) {
    return true;
  }
  // The release feed parser throws a plain Error with this message when the feed has no entry.
  // It carries no code, so the message is the only marker.
  if ('message' in error && error.message === NO_PUBLISHED_RELEASE_MESSAGE) {
    return true;
  }
  if (code === CHANNEL_FILE_MISSING) {
    return false;
  }
  return 'statusCode' in error && error.statusCode === 404;
}

/**
 * Stands in for electron-updater when the app does not supply one, as in tests. The updater
 * calls the backend only in a packaged app, so these methods do not run in practice.
 */
export const noopUpdaterBackend: UpdaterBackend = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  allowPrerelease: false,
  logger: null,
  checkForUpdates: () => Promise.resolve(null),
  downloadUpdate: () => Promise.resolve([]),
  quitAndInstall: () => undefined,
  on: () => undefined,
};

/** Passes electron-updater's log lines to the app log, which redacts every string it writes. */
function updaterLogger(log: Logger): UpdaterLogger {
  const text = (value: unknown): string => {
    if (value instanceof Error) {
      return value.message;
    }
    if (typeof value === 'string') {
      return value;
    }
    try {
      return String(value);
    } catch {
      return 'unrepresentable value';
    }
  };
  return {
    info: (message) => log.info(text(message)),
    warn: (message) => log.warn(text(message)),
    error: (message) => {
      const line = text(message);
      // electron-updater logs the empty release feed as an error. It is the normal state of a
      // repository without releases, so it goes to the info level.
      if (line.includes(NO_PUBLISHED_RELEASE_MESSAGE)) {
        log.info(line);
        return;
      }
      log.error(line);
    },
  };
}
