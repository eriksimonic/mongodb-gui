import { randomUUID } from 'node:crypto';
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Writes text to a file that does not exist yet. The text goes to a temporary file beside the
 * target, which is renamed into place. A target that exists is left alone, and the call returns
 * false. The temporary file is removed on every path.
 */
export function writeNewFile(path: string, content: string): boolean {
  if (existsSync(path)) {
    return false;
  }
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(temporary, content, { flag: 'wx' });
  try {
    if (existsSync(path)) {
      return false;
    }
    renameSync(temporary, path);
    return true;
  } finally {
    rmSync(temporary, { force: true });
  }
}
