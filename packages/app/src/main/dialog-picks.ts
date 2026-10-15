import { type DialogResult } from '@mongo-gui/core';
import { type NativeDialogs } from './rpc/router';

// Lets end-to-end tests drive the native dialogs. index.ts uses it only when the app is not packaged.
export function scriptedDialogs(raw: string): NativeDialogs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('MONGO_GUI_DIALOG_PICKS is not valid JSON');
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new Error('MONGO_GUI_DIALOG_PICKS must be a JSON array of path strings');
  }
  const queue: string[] = [...parsed];

  const next = async (): Promise<DialogResult> => {
    const path = queue.shift();
    return path === undefined ? {} : { path };
  };

  return {
    showOpenDialog: next,
    showSaveDialog: next,
    showItemInFolder: () => {},
  };
}
