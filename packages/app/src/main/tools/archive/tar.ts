import { gunzipSync } from 'node:zlib';

export interface ArchiveEntry {
  readonly name: string;
  readonly data: Buffer;
  // Octal mode from the archive, when it carries one.
  readonly mode?: number;
}

const BLOCK = 512;

function field(header: Buffer, start: number, length: number): string {
  const slice = header.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

function octal(header: Buffer, start: number, length: number, what: string): number {
  const text = field(header, start, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`The tar archive has an invalid ${what} field.`);
  return Number.parseInt(text, 8);
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

/**
 * Reads a gzipped ustar archive into memory. Regular files are returned, directories are
 * skipped, and links are refused.
 */
export function readTarGz(buffer: Buffer): ArchiveEntry[] {
  const tar = gunzipSync(buffer);
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) {
      const next = tar.subarray(offset + BLOCK, offset + 2 * BLOCK);
      if (next.length < BLOCK || isZeroBlock(next)) break;
      offset += BLOCK;
      continue;
    }
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const fullName = prefix === '' ? name : `${prefix}/${name}`;
    const mode = octal(header, 100, 8, 'mode');
    const size = octal(header, 124, 12, 'size');
    const typeflag = String.fromCharCode(header[156] ?? 0);
    offset += BLOCK;

    if (typeflag === '1' || typeflag === '2') {
      throw new Error(`The tar archive contains a link entry (${fullName}).`);
    }
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (offset + size > tar.length) throw new Error('The tar archive is truncated.');
    if (typeflag === '0' || typeflag === '\0') {
      entries.push({
        name: fullName,
        data: Buffer.from(tar.subarray(offset, offset + size)),
        mode,
      });
    }
    offset += padded;
  }
  return entries;
}
