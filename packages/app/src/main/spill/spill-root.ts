import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
} from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import {
  createSpillContext,
  disposeSpill,
  readSpillFile,
  releaseSpillRun,
  type SpillContext,
} from '@mongo-gui/storage/spill';
import { log } from '../log';

/**
 * Where this instance keeps its encrypted spill files, and when they go. The format lives in
 * storage. The placement policy (disk, not RAM; owner-only; sweep of dead instances) is
 * Electron-main-only, so it sits here.
 */
export interface SpillRoot {
  readonly ctx: SpillContext;
  read(ref: string): string;
  release(runId: string): void;
  dispose(): void;
}

export interface SpillRootOptions {
  /** Candidate base folders in order of preference. The first usable one wins. */
  readonly bases: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly pid?: number;
  readonly uid?: number | undefined;
  /** Reports whether a folder is backed by RAM. Defaults to a filesystem check on Linux. */
  readonly isRamFs?: (dir: string) => boolean;
  /** Epoch ms of the last boot. Defaults to now minus the uptime. */
  readonly bootMs?: number;
}

const TMPFS_MAGIC = 0x01021994;
const RAMFS_MAGIC = 0x858458f6;

export function createSpillRoot(options: SpillRootOptions): SpillRoot | undefined {
  const platform = options.platform ?? process.platform;
  const prepare: PrepareOptions = {
    pid: options.pid ?? process.pid,
    uid: 'uid' in options ? options.uid : process.getuid?.(),
    posix: platform !== 'win32',
    isRamFs: options.isRamFs ?? ((dir: string) => defaultIsRamFs(dir, platform)),
    bootMs: options.bootMs ?? Date.now() - uptime() * 1000,
  };
  let root: SpillRoot | undefined;
  // Every base is swept, not only the one in use: an earlier run may have used another base
  // (a changed TMPDIR, a remount), and its files must not stay.
  for (const base of options.bases) {
    try {
      const parent = usableParent(base, prepare, root === undefined);
      if (parent === undefined) {
        continue;
      }
      sweepDeadInstances(parent, prepare);
      if (root === undefined) {
        root = rootAt(claimInstanceDir(parent, prepare.pid));
      }
    } catch (error) {
      log.warn('spill base is not usable', { code: (error as NodeJS.ErrnoException).code });
    }
  }
  if (root === undefined) {
    log.warn('no spill folder is usable, so large results stay in memory');
  }
  return root;
}

function rootAt(dir: string): SpillRoot {
  const ctx = createSpillContext(dir);
  let disposed = false;
  return {
    ctx,
    read: (ref) => readSpillFile(ctx, ref),
    release: (runId) => {
      releaseSpillRun(ctx, runId);
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        disposeSpill(ctx);
      }
    },
  };
}

interface PrepareOptions {
  readonly pid: number;
  readonly uid: number | undefined;
  readonly posix: boolean;
  readonly isRamFs: (dir: string) => boolean;
  readonly bootMs: number;
}

/**
 * Returns the per-user folder under the base, or undefined when the base cannot be used. A base
 * that is only swept (create is false) is left alone when it holds no such folder.
 */
function usableParent(base: string, options: PrepareOptions, create: boolean): string | undefined {
  const parent = join(base, `mongo-gui-spill-${options.uid ?? 'user'}`);
  if (create) {
    mkdirSync(base, { recursive: true, mode: 0o700 });
  } else if (!existsSync(parent)) {
    return undefined;
  }
  if (options.isRamFs(base)) {
    return undefined;
  }
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const info = lstatSync(parent);
  if (!info.isDirectory()) {
    return undefined;
  }
  if (options.posix && options.uid !== undefined) {
    if (info.uid !== options.uid) {
      return undefined;
    }
    if ((info.mode & 0o077) !== 0) {
      chmodSync(parent, 0o700);
    }
  }
  return parent;
}

function claimInstanceDir(parent: string, pid: number): string {
  const dir = join(parent, String(pid));
  // A folder under our own pid is left by an instance that died and whose pid was reused.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

/**
 * Removes the folders of instances that are gone, which covers a crash. Another instance may be
 * running, because the app has no single-instance lock, so a folder of a live pid stays, unless
 * nothing in it changed since the machine booted, which means the pid has been reused.
 */
function sweepDeadInstances(parent: string, options: PrepareOptions): void {
  for (const name of readdirSync(parent)) {
    if (!/^\d+$/.test(name) || Number(name) === options.pid) {
      continue;
    }
    const dir = join(parent, name);
    if (isAlive(Number(name)) && statSync(dir).mtimeMs >= options.bootMs) {
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: gone. EPERM: the process belongs to someone else. This folder is ours (the parent is
    // checked to be owned by this user), so that process is not our instance either.
    return false;
  }
}

function defaultIsRamFs(dir: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'linux') {
    return false;
  }
  const { type } = statfsSync(dir);
  return type === TMPFS_MAGIC || type === RAMFS_MAGIC;
}
