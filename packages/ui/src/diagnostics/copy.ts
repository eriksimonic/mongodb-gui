import { notifications } from '@mantine/notifications';
import { notifyError } from '../components/notify-error';

/** Copies text to the clipboard. A refused copy shows the browser's reason. */
export async function copyText(text: string, label = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notifications.show({ color: 'teal', title: label, message: '', autoClose: 1500 });
  } catch (failure) {
    notifyError(failure, 'Copy failed');
  }
}
