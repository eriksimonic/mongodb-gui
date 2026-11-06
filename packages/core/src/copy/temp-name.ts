import { utf8ByteLength } from '../schemas/layout';

const TEMP_PREFIX = '__copy_';
// The most bytes in "database.collection".
const MAX_NAMESPACE_BYTES = 255;

/**
 * A temporary collection name for a drop-and-replace copy. It holds the job id whole, and the
 * target name is cut on a character boundary so "database.name" stays within the byte limit.
 */
export function tempCollectionName(database: string, target: string, jobId: string): string {
  const prefix = `${TEMP_PREFIX}${jobId}_`;
  let room = MAX_NAMESPACE_BYTES - utf8ByteLength(database) - 1 - utf8ByteLength(prefix);
  let kept = '';
  for (const char of target) {
    const size = utf8ByteLength(char);
    if (size > room) {
      break;
    }
    kept += char;
    room -= size;
  }
  return `${prefix}${kept}`;
}
