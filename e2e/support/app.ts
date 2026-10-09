import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const mainEntry = join(repoRoot, 'packages/app/out/main/index.js');
const APP_EXIT_TIMEOUT_MS = 30_000;

/**
 * A line that counts as an error. Covers Node and Chromium `Error` text, uncaught renderer
 * exceptions, the `"level":"error"` lines from the main-process logger, and Chromium's
 * `ERROR:` prefix.
 */
const ERROR_LINE = /Error|Uncaught|"level":"error"|ERROR:/;

/**
 * Known harmless messages from Chromium on Linux runners. Add an entry only with a reason.
 * Each pattern must match one exact message type, so a new error still fails the run.
 */
export const HARMLESS_LOG_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly reason: string;
}[] = [
  {
    pattern: /ERROR:dbus\/(bus|object_proxy)\.cc:\d+\]/,
    reason:
      'Headless CI runners have no session bus. Chromium logs the failed D-Bus connection and carries on.',
  },
  {
    pattern:
      /ERROR:ui\/ozone\/platform\/wayland\/gpu\/wayland_surface_factory\.cc:\d+\] '--ozone-platform=wayland' is not compatible with Vulkan/,
    reason:
      'A desktop session with a Wayland display makes Chromium warn about Vulkan. The app still renders.',
  },
  {
    pattern: /ERROR:ui\/events\/platform\/wayland\/wayland_event_watcher\.cc:\d+\] libwayland:/,
    reason:
      'libwayland reports tablet proxies still attached when Electron exits on a Wayland display. Harmless.',
  },
];

export interface AppSession {
  readonly app: ElectronApplication;
  readonly window: Page;
  /** Lines the main process wrote to stderr. */
  readonly mainStderr: string[];
  /** Renderer console errors and uncaught exceptions, prefixed with `Uncaught` where they apply. */
  readonly rendererErrors: string[];
}

/** Creates an empty profile directory for one app session. The caller removes it. */
export function createUserDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mongo-gui-e2e-'));
}

export function removeUserDataDir(userDataDir: string): Promise<void> {
  return rm(userDataDir, { recursive: true, force: true, maxRetries: 3 });
}

/** Launches the built app from packages/app/out against the given profile directory. */
export async function launchApp(userDataDir: string): Promise<AppSession> {
  const app = await electron.launch({
    executablePath: electronBinary(),
    args: [mainEntry, '--no-sandbox'],
    env: {
      ...process.env,
      MONGO_GUI_USER_DATA: userDataDir,
      ELECTRON_ENABLE_LOGGING: '1',
    },
  });
  const mainStderr: string[] = [];
  collectLines(app.process().stderr, mainStderr);

  const window = await app.firstWindow();
  const rendererErrors: string[] = [];
  window.on('console', (message) => {
    if (message.type() === 'error') {
      rendererErrors.push(message.text());
    }
  });
  window.on('pageerror', (error) => {
    rendererErrors.push(`Uncaught ${error.message}`);
  });
  return { app, window, mainStderr, rendererErrors };
}

/** Closes the window the way a user does, then waits for the process to exit. */
export async function closeWindowAndWaitForExit(session: AppSession): Promise<number | null> {
  const exit = waitForExit(session.app.process());
  await session.window.close();
  return exit;
}

/** Stops an app that a failing test left running. Does nothing when the app already exited. */
export async function forceClose(session: AppSession): Promise<void> {
  await session.app.close().catch(() => undefined);
}

/** Returns the lines that look like errors and are not on the allowlist. */
export function unexpectedErrorLines(lines: readonly string[]): string[] {
  return lines.filter(
    (line) =>
      ERROR_LINE.test(line) && !HARMLESS_LOG_PATTERNS.some((entry) => entry.pattern.test(line)),
  );
}

/** Asserts that neither the main process nor the renderer reported an error. */
export function expectCleanLogs(session: AppSession): void {
  expect(unexpectedErrorLines(session.mainStderr), 'main process stderr').toEqual([]);
  expect(unexpectedErrorLines(session.rendererErrors), 'renderer console').toEqual([]);
}

function electronBinary(): string {
  const requireFromApp = createRequire(join(repoRoot, 'packages/app/package.json'));
  const binary: unknown = requireFromApp('electron');
  if (typeof binary !== 'string') {
    throw new Error('The electron package did not export a binary path.');
  }
  return binary;
}

function collectLines(stream: Readable | null, sink: string[]): void {
  if (stream === null) {
    throw new Error('The Electron process has no stderr stream.');
  }
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    const parts = (pending + chunk).split('\n');
    pending = parts.pop() ?? '';
    sink.push(...parts.filter((line) => line.trim() !== ''));
  });
  stream.on('end', () => {
    if (pending.trim() !== '') {
      sink.push(pending);
    }
  });
}

async function waitForExit(proc: ChildProcess): Promise<number | null> {
  if (proc.exitCode !== null) {
    return proc.exitCode;
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`The app did not exit within ${APP_EXIT_TIMEOUT_MS} ms.`));
    }, APP_EXIT_TIMEOUT_MS);
  });
  const exited = new Promise<number | null>((resolve) => {
    proc.once('exit', (code) => {
      resolve(code);
    });
  });
  try {
    return await Promise.race([exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
