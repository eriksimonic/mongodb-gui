import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { DecryptError, open, seal } from '../crypto/aead';

/**
 * Encrypted spill files for large query results. The shell process writes, main reads, so both
 * share this format. A file is a sequence of `u32BE(len) || sealed` chunks; each chunk's AAD binds
 * store id, ref, chunk index and a final flag, so drop, reorder, move and truncate fail to open.
 */

export interface SpillContext {
  readonly key: Buffer;
  readonly storeId: string;
  readonly dir: string;
}

export class SpillError extends Error {
  readonly code: 'NOT_FOUND' | 'CORRUPT';

  constructor(code: 'NOT_FOUND' | 'CORRUPT', message: string) {
    super(message);
    this.name = 'SpillError';
    this.code = code;
  }
}

/** UTF-16 units per chunk: at most ~768 KB of UTF-8 before sealing. */
export const SPILL_CHUNK_CHARS = 262_144;
export const SPILL_REF_PATTERN = /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

const ID_PATTERN = /^[0-9a-f-]{36}$/;
const KEY_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const HEADER_BYTES = 4;
const MAX_SEALED_BYTES = 2 * 1024 * 1024;
const ENV_DIR = 'MONGO_GUI_SPILL_DIR';
const ENV_KEY = 'MONGO_GUI_SPILL_KEY';
const ENV_STORE = 'MONGO_GUI_SPILL_STORE';

/** Random in-memory key, never persisted. Does not create `dir`. */
export function createSpillContext(dir: string): SpillContext {
  return { key: randomBytes(32), storeId: randomUUID(), dir };
}

export function spillEnv(ctx: SpillContext): Record<string, string> {
  return {
    [ENV_DIR]: ctx.dir,
    [ENV_KEY]: ctx.key.toString('hex'),
    [ENV_STORE]: ctx.storeId,
  };
}

export function spillFromEnv(env: NodeJS.ProcessEnv): SpillContext | undefined {
  const dir = env[ENV_DIR];
  const keyHex = env[ENV_KEY];
  const storeId = env[ENV_STORE];
  if (!dir || !storeId || !keyHex || !KEY_HEX_PATTERN.test(keyHex)) {
    return undefined;
  }
  return { key: Buffer.from(keyHex, 'hex'), storeId, dir };
}

export function writeSpillFile(
  ctx: SpillContext,
  runId: string,
  text: string,
): { ref: string; fileBytes: number } {
  assertId(runId, 'runId');
  const ref = `${runId}/${randomUUID()}`;
  const runDir = join(ctx.dir, runId);
  // Not recursive: after the wipe the instance folder is gone, and a late write must fail, not
  // bring the folder back.
  try {
    mkdirSync(runDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  const path = join(ctx.dir, ref);
  const fd = openSync(path, 'wx', 0o600);
  let fileBytes = 0;
  try {
    const slices = sliceText(text);
    for (let i = 0; i < slices.length; i++) {
      const plain = Buffer.from(slices[i] as string, 'utf8');
      let sealed: Buffer;
      try {
        sealed = seal(ctx.key, plain, chunkAad(ctx, ref, i, i === slices.length - 1));
      } finally {
        plain.fill(0);
      }
      const header = Buffer.alloc(HEADER_BYTES);
      header.writeUInt32BE(sealed.length);
      writeAll(fd, header);
      writeAll(fd, sealed);
      fileBytes += HEADER_BYTES + sealed.length;
    }
    closeSync(fd);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    try {
      unlinkSync(path);
    } catch {
      // best effort
    }
    throw error;
  }
  return { ref, fileBytes };
}

export function readSpillFile(ctx: SpillContext, ref: string): string {
  if (!SPILL_REF_PATTERN.test(ref)) {
    throw new SpillError('NOT_FOUND', 'invalid spill reference');
  }
  let fd: number;
  try {
    fd = openSync(join(ctx.dir, ref), 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SpillError('NOT_FOUND', 'spill file not found');
    }
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) {
      throw new SpillError('CORRUPT', 'spill file is empty');
    }
    const parts: string[] = [];
    let offset = 0;
    for (let index = 0; offset < size; index++) {
      if (offset + HEADER_BYTES > size) {
        throw new SpillError('CORRUPT', 'trailing partial chunk header');
      }
      const header = Buffer.alloc(HEADER_BYTES);
      readExact(fd, header, offset);
      const length = header.readUInt32BE(0);
      const end = offset + HEADER_BYTES + length;
      if (length === 0 || length > MAX_SEALED_BYTES || end > size) {
        throw new SpillError('CORRUPT', 'bad chunk length');
      }
      const sealed = Buffer.alloc(length);
      readExact(fd, sealed, offset + HEADER_BYTES);
      let plain: Buffer;
      try {
        plain = open(ctx.key, sealed, chunkAad(ctx, ref, index, end === size));
      } catch (error) {
        if (error instanceof DecryptError) {
          throw new SpillError('CORRUPT', 'spill chunk failed authentication');
        }
        throw error;
      }
      parts.push(plain.toString('utf8'));
      plain.fill(0);
      offset = end;
    }
    return parts.join('');
  } finally {
    closeSync(fd);
  }
}

export function releaseSpillRun(ctx: SpillContext, runId: string): void {
  assertId(runId, 'runId');
  rmSync(join(ctx.dir, runId), { recursive: true, force: true });
}

/** Zeroes the key and removes everything under the spill directory. */
export function disposeSpill(ctx: SpillContext): void {
  ctx.key.fill(0);
  rmSync(ctx.dir, { recursive: true, force: true });
}

function assertId(id: string, what: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new TypeError(`${what} must be a uuid`);
  }
}

function chunkAad(ctx: SpillContext, ref: string, index: number, final: boolean): Buffer {
  return Buffer.from(`${ctx.storeId}\n${ref}\n${index}\n${final ? 1 : 0}`, 'utf8');
}

/** Slices of at most SPILL_CHUNK_CHARS units that never split a surrogate pair. */
function sliceText(text: string): string[] {
  const slices: string[] = [];
  let start = 0;
  do {
    let end = Math.min(start + SPILL_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        end--;
      }
    }
    slices.push(text.slice(start, end));
    start = end;
  } while (start < text.length);
  return slices;
}

function writeAll(fd: number, buffer: Buffer): void {
  let written = 0;
  while (written < buffer.length) {
    written += writeSync(fd, buffer, written, buffer.length - written);
  }
}

function readExact(fd: number, buffer: Buffer, position: number): void {
  let read = 0;
  while (read < buffer.length) {
    const n = readSync(fd, buffer, read, buffer.length - read, position + read);
    if (n === 0) {
      throw new SpillError('CORRUPT', 'unexpected end of spill file');
    }
    read += n;
  }
}
