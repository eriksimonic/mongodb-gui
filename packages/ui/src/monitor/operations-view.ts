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

/** Background threads have no client and no operation. They are not user work, so they stay. */
export function isSystemOperation(operation: RunningOperation): boolean {
  return operation.op === 'none' && operation.client === undefined;
}

/** Why a row cannot be killed from this panel, or undefined when it can. */
export function killBlockReason(operation: RunningOperation): string | undefined {
  if (isSyntheticOpid(operation.opid)) {
    return 'Idle connections have no operation to kill.';
  }
  if (isSystemOperation(operation)) {
    return 'System threads cannot be killed from here.';
  }
  return undefined;
}
