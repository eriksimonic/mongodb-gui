import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { appError, AppErrorException } from '@mongo-gui/core';

export interface HashedFile {
  // Posix separators, relative to the hashed folder.
  path: string;
  bytes: number;
  sha256: string;
}

function cancelled(): AppErrorException {
  return new AppErrorException(appError('CANCELLED', 'The operation was cancelled.'));
}

/** Streams a file through sha256. `onBytes` gets the size of each chunk as it is read. */
export async function hashFile(
  path: string,
  onBytes: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw cancelled();
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw cancelled();
      const bytes = chunk as Buffer;
      hash.update(bytes);
      onBytes(bytes.byteLength);
    }
  } finally {
    stream.destroy();
  }
  return hash.digest('hex');
}

/** Regular files under a folder as posix relative paths, sorted. Links and other entries are skipped. */
export async function listFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(current, entry.name), relative);
      else if (entry.isFile()) found.push(relative);
    }
  }
  await walk(dir, '');
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Hashes every regular file under a folder, in path order. */
export async function hashDirectory(
  dir: string,
  onBytes: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<{ files: HashedFile[]; bytes: number }> {
  const files: HashedFile[] = [];
  let total = 0;
  for (const path of await listFiles(dir)) {
    let size = 0;
    const sha256 = await hashFile(
      join(dir, ...path.split('/')),
      (bytes) => {
        size += bytes;
        onBytes(bytes);
      },
      signal,
    );
    files.push({ path, bytes: size, sha256 });
    total += size;
  }
  return { files, bytes: total };
}
