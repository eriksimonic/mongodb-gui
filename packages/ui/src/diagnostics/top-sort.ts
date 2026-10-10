import type { TopEntry } from '@mongo-gui/core';

export type TopColumn = 'ns' | 'total' | 'reads' | 'writes' | 'readLock' | 'writeLock' | 'commands';

export type SortDirection = 'asc' | 'desc';

export interface TopSort {
  readonly column: TopColumn;
  readonly direction: SortDirection;
}

export const DEFAULT_TOP_SORT: TopSort = { column: 'total', direction: 'desc' };

/** Reads are queries and getmore calls. Writes are inserts, updates and removes. */
export function readCount(entry: TopEntry): number {
  return entry.queries.count + entry.getmore.count;
}

export function writeCount(entry: TopEntry): number {
  return entry.insert.count + entry.update.count + entry.remove.count;
}

/** The sums of the time and count columns over every namespace. */
export function topTotals(entries: readonly TopEntry[]) {
  return entries.reduce(
    (sum, entry) => ({
      total: sum.total + entry.total.timeMs,
      reads: sum.reads + readCount(entry),
      writes: sum.writes + writeCount(entry),
      readLock: sum.readLock + entry.readLock.timeMs,
      writeLock: sum.writeLock + entry.writeLock.timeMs,
      commands: sum.commands + entry.commands.count,
    }),
    { total: 0, reads: 0, writes: 0, readLock: 0, writeLock: 0, commands: 0 },
  );
}

/** A sorted copy. Namespaces compare as text, every other column as a number. */
export function sortTop(entries: readonly TopEntry[], sort: TopSort): TopEntry[] {
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...entries].sort((left, right) => {
    if (sort.column === 'ns') {
      return sign * left.ns.localeCompare(right.ns);
    }
    return sign * (valueOf(left, sort.column) - valueOf(right, sort.column));
  });
}

function valueOf(entry: TopEntry, column: Exclude<TopColumn, 'ns'>): number {
  switch (column) {
    case 'total':
      return entry.total.timeMs;
    case 'reads':
      return readCount(entry);
    case 'writes':
      return writeCount(entry);
    case 'readLock':
      return entry.readLock.timeMs;
    case 'writeLock':
      return entry.writeLock.timeMs;
    case 'commands':
      return entry.commands.count;
  }
}
