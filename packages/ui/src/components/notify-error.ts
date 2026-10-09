import { toAppError } from '@mongo-gui/core';
import { notifications } from '@mantine/notifications';

/**
 * The text to show for a thrown error. The server's reason (`detail`) is what tells the user what
 * to change, for example a validator rejection, so it is shown when present. Otherwise the message.
 */
export function errorText(error: unknown): string {
  const appError = toAppError(error);
  return appError.detail ?? appError.message;
}

/** Shows a red notification with the text of a thrown error. */
export function notifyError(error: unknown, title = 'Something went wrong'): void {
  notifications.show({ color: 'red', title, message: errorText(error) });
}

/** Runs an action and reports its failure as a notification. Never rejects. */
export async function runReported(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    notifyError(error);
  }
}
