import { createUiEventBus } from '../profiler/profiler-events';

/**
 * Requests to the open editor. The store asks a tab to take text at its cursor, and the editor
 * component does the insert, because only Monaco knows the cursor.
 */
export type EditorUiEvent =
  | { readonly type: 'editor:insert'; readonly tabId: string; readonly text: string }
  /** Runs what the keyboard runs: the selection or the statement, or all of the text. */
  | { readonly type: 'editor:command'; readonly tabId: string; readonly command: 'run' | 'runAll' };

export const editorUiEvents = createUiEventBus<EditorUiEvent>();
