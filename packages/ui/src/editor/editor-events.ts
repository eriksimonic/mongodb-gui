import { createUiEventBus } from '../profiler/profiler-events';

/**
 * Requests to the open editor. The store asks a tab to take text at its cursor, and the editor
 * component does the insert, because only Monaco knows the cursor.
 */
export type EditorUiEvent =
  | { readonly type: 'editor:insert'; readonly tabId: string; readonly text: string }
  /** Runs what the keyboard runs: the selection or the statement, or all of the text. */
  | {
      readonly type: 'editor:command';
      readonly tabId: string;
      readonly command: 'run' | 'runAll' | 'explain';
    };

export const editorUiEvents = createUiEventBus<EditorUiEvent>();

/**
 * The text an insert adds in place of the selection. `before` and `after` are the text on either
 * side of the cursor. Code that follows text on its line starts a new line, and code that is
 * followed by text on its line ends one.
 */
export function insertionText(before: string, after: string, code: string): string {
  const lead = before !== '' && !before.endsWith('\n') ? '\n' : '';
  const tail = after !== '' && !after.startsWith('\n') ? '\n' : '';
  return `${lead}${code}${tail}`;
}
