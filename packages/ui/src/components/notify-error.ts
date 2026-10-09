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
