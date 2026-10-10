import { fail } from './mock-support';

/**
 * The picks the mock dialogs register, enforced the way the router enforces them, so the dev UI
 * shows the same refusals. An upload or an import needs a file the open dialog returned, a preview
 * only checks that pick, and the start that uses it takes it up. A download needs a save path or a
 * folder the dialogs returned.
 */
export interface MockPicks {
  opened(path: string): void;
  folder(path: string): void;
  saved(path: string): void;
  requireOpened(path: string): void;
  useOpened(path: string): void;
  requireDownloadTarget(path: string): void;
  requireSaved(path: string): void;
  consumeSaved(path: string): void;
}

const DOT_DOT_MESSAGE = 'A path may not contain ".." segments.';
const PICK_FILE_MESSAGE = 'Choose the file in a dialog first.';
const SAVE_FIRST_MESSAGE = 'Choose the file with Save as first.';
const PICK_TARGET_MESSAGE = 'Choose the folder or the save location in a dialog first.';

export function createMockPicks(): MockPicks {
  const openedFiles = new Set<string>();
  const folders = new Set<string>();
  const savePaths = new Set<string>();

  const refuseDotDot = (path: string): void => {
    if (path.split(/[\\/]/).includes('..')) {
      throw fail('VALIDATION', DOT_DOT_MESSAGE);
    }
  };

  return {
    opened(path) {
      openedFiles.add(path);
    },
    folder(path) {
      folders.add(path);
    },
    saved(path) {
      savePaths.add(path);
    },
    requireOpened(path) {
      refuseDotDot(path);
      if (!openedFiles.has(path)) {
        throw fail('VALIDATION', PICK_FILE_MESSAGE);
      }
    },
    useOpened(path) {
      openedFiles.delete(path);
    },
    requireSaved(path) {
      refuseDotDot(path);
      if (!savePaths.has(path)) {
        throw fail('VALIDATION', SAVE_FIRST_MESSAGE);
      }
    },
    consumeSaved(path) {
      savePaths.delete(path);
    },
    requireDownloadTarget(path) {
      refuseDotDot(path);
      const folder = /^(.*)[\\/][^\\/]*$/.exec(path)?.[1] ?? '';
      if (!savePaths.has(path) && !folders.has(folder)) {
        throw fail('VALIDATION', PICK_TARGET_MESSAGE);
      }
    },
  };
}
