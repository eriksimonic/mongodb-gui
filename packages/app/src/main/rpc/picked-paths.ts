import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { appError, AppErrorException } from '@mongo-gui/core';

/**
 * Refuses a `..` segment and returns the absolute path. The transfer receives this resolved path,
 * never the request's text, so the kernel writes where the check looked.
 */
export function resolveRequestPath(path: string): string {
  if (path.split(/[\\/]/).includes('..')) {
    throw new AppErrorException(appError('VALIDATION', 'A path may not contain ".." segments.'));
  }
  return resolve(path);
}

/**
 * The real location of a folder, or undefined when it cannot be read. A folder that is a symlink
 * is compared by where it points, so a link inside a picked folder cannot lead out of it.
 */
export function realFolder(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * The resolved path of a file the open dialog returned this session. Checking does not use the pick
 * up, so the caller uses it only when the transfer starts.
 */
export function pickedFile(path: string, openedFiles: ReadonlySet<string>): string {
  const file = resolveRequestPath(path);
  if (!openedFiles.has(file)) {
    throw new AppErrorException(appError('VALIDATION', 'Choose the file in a dialog first.'));
  }
  return file;
}
