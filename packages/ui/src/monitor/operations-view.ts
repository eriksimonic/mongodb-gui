import { isSyntheticOpid, type RunningOperation } from '@mongo-gui/core';

const EXCERPT_LIMIT = 240;

/** Operations whose namespace contains the search text, ignoring case. Blank search keeps all. */
export function filterOperations(
  operations: readonly RunningOperation[],
  search: string,
): RunningOperation[] {
  const needle = search.trim().toLowerCase();
  if (needle === '') {
    return [...operations];
  }
  return operations.filter((operation) => operation.ns.toLowerCase().includes(needle));
}

/** The command as one line of JSON, cut to a short excerpt for the kill confirmation. */
export function commandExcerpt(command: unknown, limit = EXCERPT_LIMIT): string {
  if (command === undefined) {
    return 'No command recorded';
  }
  let text: string | undefined;
  try {
    text = JSON.stringify(command);
  } catch {
    return 'Command cannot be shown';
  }
  if (text === undefined) {
    return 'No command recorded';
  }
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

/** Idle connections carry a placeholder id, and the server cannot kill them. */
export function isKillable(opid: string | number): boolean {
  return !isSyntheticOpid(opid);
}
