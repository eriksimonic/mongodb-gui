export interface RestoreCounts {
  readonly restored?: number;
  readonly failed?: number;
}

// Each count matches on its own, so a line with both counts and a line with one both parse.
const COUNT = /(\d+) document\(s\) (restored successfully|failed to restore)/g;

/**
 * The counts in one mongorestore output line. Insert only skips existing _ids, and mongorestore
 * still exits 0, so the "failed to restore" count is the skipped count.
 */
export function parseRestoreCounts(line: string): RestoreCounts {
  const counts: { restored?: number; failed?: number } = {};
  for (const match of line.matchAll(COUNT)) {
    if (match[2] === 'restored successfully') {
      counts.restored = Number(match[1]);
    } else {
      counts.failed = Number(match[1]);
    }
  }
  return counts;
}
