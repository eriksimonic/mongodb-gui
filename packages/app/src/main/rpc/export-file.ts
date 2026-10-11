import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Why a picked export path may not be written, or undefined when it may. A `..` segment could leave
 * the folder the user chose. A symbolic link at the target would send the write elsewhere.
 */
export function exportTargetProblem(path: string): string | undefined {
  if (path.split(/[\\/]/).includes('..')) {
    return 'The file path may not contain "..".';
  }
  try {
    if (lstatSync(path).isSymbolicLink()) {
      return 'The file is a symbolic link. Choose another file.';
    }
  } catch {
    // A missing file is the normal case for a new export.
  }
  return undefined;
}

/**
 * Replaces the file at a path the user picked in a save dialog. The text goes to a temporary file
 * beside the target, which is then renamed over it. The rename is one step, so a reader sees the old
 * file or the new one. The temporary file is removed on every path.
 */
export function replaceFile(path: string, content: string | Uint8Array): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(temporary, content, { flag: 'wx' });
  try {
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Writes a large export in parts, so no whole-file string exists in memory. The parts go to a
 * temporary file beside the target. `commit` renames it over the target, like `replaceFile`, so a
 * reader sees the old file or the complete new one. `abort` removes it. Both are safe to repeat.
 */
export class ExportWriter {
  private readonly temporary: string;
  private fd: number | undefined;

  constructor(private readonly path: string) {
    this.temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    this.fd = openSync(this.temporary, 'wx');
  }

  append(text: string): void {
    if (this.fd !== undefined) {
      appendFileSync(this.fd, text);
    }
  }

  commit(): void {
    if (this.fd === undefined) {
      return;
    }
    try {
      this.close();
      renameSync(this.temporary, this.path);
    } finally {
      rmSync(this.temporary, { force: true });
    }
  }

  abort(): void {
    try {
      this.close();
    } finally {
      rmSync(this.temporary, { force: true });
    }
  }

  private close(): void {
    const fd = this.fd;
    this.fd = undefined;
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}
