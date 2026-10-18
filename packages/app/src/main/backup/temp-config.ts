import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, openSync } from 'node:fs';
import { mkdir, open, readdir, rm } from 'node:fs/promises';
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

/** Opening a FIFO for writing waits for a reader. Returns a function that frees a stuck writer. */
function feedFifo(path: string, yaml: string): () => void {
  void open(path, 'w')
    .then((handle) => handle.writeFile(yaml, 'utf8').finally(() => handle.close()))
    .catch(() => undefined);
  return () => {
    try {
      // A reader that opens and closes lets a writer that never found one finish.
      closeSync(openSync(path, constants.O_RDONLY | constants.O_NONBLOCK));
    } catch {
      // The FIFO is gone or nobody waits on it.
    }
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
