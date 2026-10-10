import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const PREFIX = 'tools-';
const FILE_NAME = 'config.yaml';

export interface TempConfig {
  // The config file to pass as --config.
  path: string;
  // The private folder that holds it.
  dir: string;
  // Removes the folder. Never rejects, and a second call does nothing.
  dispose: () => Promise<void>;
}

/**
 * Writes the tools config (it holds the full connection URI) into a fresh private folder:
 * `<tmpRoot>/tools-<uuid>/config.yaml`, folder mode 0700, file mode 0600. The file is created
 * with 'wx', so an existing file or link at that path makes the call fail instead of being reused.
 */
export async function writeTempConfig(tmpRoot: string, yaml: string): Promise<TempConfig> {
  await mkdir(tmpRoot, { recursive: true, mode: 0o700 });
  const dir = join(tmpRoot, `${PREFIX}${randomUUID()}`);
  await mkdir(dir, { mode: 0o700 });
  const path = join(dir, FILE_NAME);
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(yaml, 'utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    await removeQuietly(dir);
    throw error;
  }
  let disposed: Promise<void> | undefined;
  return {
    path,
    dir,
    dispose: () => (disposed ??= removeQuietly(dir)),
  };
}

/**
 * Deletes `tools-*` folders a crashed or killed run left behind. Runs at startup, before any job
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
