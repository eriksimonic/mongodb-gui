import type { LogLine, ServerLog, ServerLogKind } from '@mongo-gui/core';

/**
 * The lines of one log that the panel keeps. The server numbers every line it has written since it
 * started. A line's id is that number, so a later read of the ring buffer can tell which lines are
 * new.
 */
export interface LogWindow {
  readonly kind: ServerLogKind;
  /** Lines written since the server started, as of the newest read. */
  readonly total: number;
  /** The id of lines[0]. */
  readonly firstId: number;
  readonly lines: readonly LogLine[];
}

/** The window of one reply, with nothing kept from earlier reads. */
export function logWindowOf(reply: ServerLog): LogWindow {
  return {
    kind: reply.kind,
    total: reply.total,
    firstId: reply.total - reply.lines.length,
    lines: reply.lines,
  };
}

/**
 * The window after a read. Lines the server still holds keep their objects, and only lines with
 * ids past the previous read are appended. A restart of the server, which lowers the total, or a
 * gap between the reads starts the window again.
 */
export function mergeLogWindow(previous: LogWindow | undefined, reply: ServerLog): LogWindow {
  const next = logWindowOf(reply);
  if (previous === undefined || previous.kind !== reply.kind || reply.total < previous.total) {
    return next;
  }
  const previousEnd = previous.firstId + previous.lines.length;
  if (next.firstId > previousEnd) {
    return next;
  }
  const kept = previous.lines.slice(Math.max(0, next.firstId - previous.firstId));
  const appended = reply.lines.slice(Math.max(0, previousEnd - next.firstId));
  return {
    kind: reply.kind,
    total: reply.total,
    firstId: Math.max(previous.firstId, next.firstId),
    lines: [...kept, ...appended],
  };
}
