import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

const PREFIX = 'tools-';
const FIFO_NAME = 'config';
const run = promisify(execFile);

export interface ConfigPipe {
  // The value for --config. A named pipe, so the connection URI is never in a file.
  path: string;
  // A private scratch folder: working directory and restore link. Holds no secret.
  dir: string;
  // Closes the pipe and removes the folder. Never rejects, and a second call does nothing.
  dispose: () => Promise<void>;
}

/**
 * Serves the tools config (it holds the full connection URI) through a named pipe, so the secret
 * never reaches the disk. The pipe lives in a fresh private folder `<tmpRoot>/tools-<uuid>/`,
 * mode 0700. Linux and macOS use a FIFO from mkfifo, mode 0600. A FIFO holds no data, only a
 * name. Windows serves a `\\.\pipe\` name once and then stops listening. The tool reads the
 * config once. A Node stdio pipe cannot do this job, because it is a socket and a tool cannot
 * reopen a socket by path.
 */
export async function openConfigPipe(tmpRoot: string, yaml: string): Promise<ConfigPipe> {
  await mkdir(tmpRoot, { recursive: true, mode: 0o700 });
  const dir = join(tmpRoot, `${PREFIX}${randomUUID()}`);
  await mkdir(dir, { mode: 0o700 });
  let stop: () => void;
  let path: string;
  try {
    if (process.platform === 'win32') {
      path = `\\\\.\\pipe\\mongo-gui-${randomUUID()}`;
      stop = await servePipeOnce(path, yaml);
    } else {
      path = join(dir, FIFO_NAME);
      await run('mkfifo', ['-m', '600', path]);
      stop = feedFifo(path, yaml);
    }
  } catch (error) {
    await removeQuietly(dir);
    throw error;
  }
  let disposed: Promise<void> | undefined;
  return {
    path,
    dir,
    dispose: () =>
      (disposed ??= (async () => {
        stop();
        await removeQuietly(dir);
      })()),
  };
}

// Pause between attempts to open the FIFO for writing.
const RETRY_MS = 25;
// Attempts stop after this long. Every caller disposes the pipe, so this only bounds a pipe that never is.
const GIVE_UP_MS = 10 * 60_000;

/**
 * Writes the YAML once a reader has the FIFO open. A blocking open for writing would park a
 * libuv thread until a reader came. This opens without blocking, so each attempt returns at once:
 * with no reader the open fails with ENXIO, and the next attempt runs RETRY_MS later. Returns a
 * function that stops the attempts and closes the FIFO.
 */
function feedFifo(path: string, yaml: string): () => void {
  const data = Buffer.from(yaml, 'utf8');
  const deadline = Date.now() + GIVE_UP_MS;
  let fd: number | undefined;
  let offset = 0;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const later = (task: () => void): void => {
    timer = setTimeout(task, RETRY_MS);
    timer.unref();
  };
  const close = (): void => {
    if (fd === undefined) return;
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
    fd = undefined;
  };
  const write = (): void => {
    timer = undefined;
    if (stopped || fd === undefined) return;
    try {
      while (offset < data.length) {
        offset += writeSync(fd, data, offset, data.length - offset);
      }
    } catch (error) {
      // EAGAIN: the reader has not drained a full pipe yet. Any other error, such as EPIPE
      // from a reader that exited, ends the write. The tool reports the missing config itself.
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') {
        later(write);
        return;
      }
    }
    close();
  };
  const attempt = (): void => {
    timer = undefined;
    if (stopped) return;
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENXIO' && Date.now() < deadline) {
        later(attempt);
      }
      return;
    }
    write();
  };

  attempt();
  return () => {
    stopped = true;
    clearTimeout(timer);
    close();
  };
}

/** Gives the config to the first client of a named pipe, then closes the listener. */
function servePipeOnce(path: string, yaml: string): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      server.close();
      socket.on('error', () => undefined);
      socket.end(yaml);
    });
    server.once('error', reject);
    server.listen(path, () => resolve(() => server.close()));
  });
}

/**
 * Deletes `tools-*` folders a crashed or killed run left behind, including config files that older versions wrote. Runs at startup, before any job
 * exists, so every match is stale. Returns how many folders were removed. Never rejects.
 */
export async function sweepTempConfigs(tmpRoot: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(tmpRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue;
    try {
      await rm(join(tmpRoot, entry.name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // A folder that cannot be removed now is tried again on the next start.
    }
  }
  return removed;
}

async function removeQuietly(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Nothing to report: a leftover folder is removed by the next sweep.
  }
}
