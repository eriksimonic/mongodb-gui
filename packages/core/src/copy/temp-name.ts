const TEMP_PREFIX = '__copy_';
// The most bytes in "database.collection".
const MAX_NAMESPACE_BYTES = 255;

/**
 * A temporary collection name for a drop-and-replace copy. It holds the job id whole, and the
 * target name is cut on a character boundary so "database.name" stays within the byte limit.
 */
export function tempCollectionName(database: string, target: string, jobId: string): string {
  const prefix = `${TEMP_PREFIX}${jobId}_`;
  let room = MAX_NAMESPACE_BYTES - utf8Bytes(database) - 1 - utf8Bytes(prefix);
  let kept = '';
  for (const char of target) {
    const size = utf8Bytes(char);
    if (size > room) {
      break;
    }
    kept += char;
    room -= size;
  }
  return `${prefix}${kept}`;
}

// UTF-8 length, counted per code point. The core package uses no DOM or Node types here.
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
