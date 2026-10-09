import type { ConnectionProfileSummary } from '@mongo-gui/core';

/** Rows the Welcome panel shows under "Recent connections". */
export const RECENT_LIMIT = 5;

/**
 * The most recently changed connections, newest first. Ties keep the list order, and a timestamp
 * that does not parse sorts last.
 */
export function recentConnections(
  connections: readonly ConnectionProfileSummary[],
  limit: number = RECENT_LIMIT,
): ConnectionProfileSummary[] {
  return [...connections]
    .map((connection, index) => ({ connection, index, time: Date.parse(connection.updatedAt) }))
    .sort((left, right) => {
      const leftTime = Number.isNaN(left.time) ? -Infinity : left.time;
      const rightTime = Number.isNaN(right.time) ? -Infinity : right.time;
      return rightTime - leftTime || left.index - right.index;
    })
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.connection);
}

/** The idle lock sentence on the Welcome panel. Uses the minutes the vault locks after. */
export function idleLockHint(minutes: number): string {
  const unit = minutes === 1 ? 'minute' : 'minutes';
  return `Your master password unlocks the vault at each start. The app locks after ${minutes} ${unit} without activity.`;
}
