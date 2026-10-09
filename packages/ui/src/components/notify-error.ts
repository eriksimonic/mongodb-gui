import { toAppError } from '@mongo-gui/core';
import { notifications } from '@mantine/notifications';

/**
 * The text to show for a thrown error. The server's reason (`detail`) says what to change, for
 * example a validator rejection, so it follows the message. A detail that already starts with the
 * message is shown alone, so the message is not repeated.
 */
export function errorText(error: unknown): string {
  const { message, detail } = toAppError(error);
  if (detail === undefined || detail === '') {
    return message;
  }
  return detail.startsWith(message) ? detail : `${message}: ${detail}`;
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
