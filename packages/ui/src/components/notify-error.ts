import { toAppError } from '@mongo-gui/core';
import { notifications } from '@mantine/notifications';

/** Shows a red notification with the message of a thrown error. */
export function notifyError(error: unknown, title = 'Something went wrong'): void {
  notifications.show({ color: 'red', title, message: toAppError(error).message });
}

/** Runs an action and reports its failure as a notification. Never rejects. */
export async function runReported(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    notifyError(error);
  }
}

/**
 * The text every inline error shows: the message, then the detail when the backend gave one.
 * Components render this instead of the raw error, so the wording is the same everywhere.
 */
export function errorText(error: unknown): string {
  const failure = toAppError(error);
  const message = failure.message.replace(/\.$/, '');
  return failure.detail === undefined ? failure.message : `${message}: ${failure.detail}`;
}
