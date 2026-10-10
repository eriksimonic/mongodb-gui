import { inflateRawSync } from 'node:zlib';
import type { ArchiveEntry } from './tar';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 65535;
const ZIP64_MARKER = 0xffffffff;

function findEndRecord(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - (EOCD_MIN + MAX_COMMENT));
  for (let at = buffer.length - EOCD_MIN; at >= lowest; at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD_SIGNATURE) return at;
  }
  throw new Error('The zip archive has no end-of-central-directory record.');
}

/**
 * Reads a zip archive into memory using the central directory, so entries written with a
 * data descriptor (sizes zero in the local header) work. Directory entries are skipped.
 */
export function readZip(buffer: Buffer): ArchiveEntry[] {
  const end = findEndRecord(buffer);
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || directorySize === ZIP64_MARKER || directoryOffset === ZIP64_MARKER) {
    throw new Error('Zip64 archives are not supported.');
  }

  const entries: ArchiveEntry[] = [];
  let at = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new Error('The zip central directory is damaged.');
    }
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;

    if (compressedSize === ZIP64_MARKER || size === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
      throw new Error(`Zip64 entries are not supported (${name}).`);
    }
    if ((flags & 1) !== 0) throw new Error(`The zip entry ${name} is encrypted.`);
    if (name.endsWith('/')) continue;

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`The zip local header for ${name} is damaged.`);
    }
    const start =
      localOffset +
      30 +
      buffer.readUInt16LE(localOffset + 26) +
      buffer.readUInt16LE(localOffset + 28);
    if (start + compressedSize > buffer.length)
      throw new Error(`The zip entry ${name} is truncated.`);
    const raw = buffer.subarray(start, start + compressedSize);

    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`The zip entry ${name} uses unsupported compression method ${method}.`);
    if (data.length !== size)
      throw new Error(`The zip entry ${name} does not match its recorded size.`);
    entries.push({ name, data });
  }
  return entries;
}
