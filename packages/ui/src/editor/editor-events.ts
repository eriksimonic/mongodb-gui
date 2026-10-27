import { createUiEventBus } from '../kit/event-bus';

/**
 * Requests to the open editor. The store asks a tab to take text at its cursor, and the editor
 * component does the insert, because only Monaco knows the cursor.
 */
export type EditorUiEvent =
  | { readonly type: 'editor:insert'; readonly tabId: string; readonly text: string }
  /** Puts the cursor in the tab's editor, as when the tab is opened from the tree. */
  | { readonly type: 'editor:focus'; readonly tabId: string }
  /** The editor of the tab has a selection, or lost it. The Run button names what it runs. */
  | { readonly type: 'editor:selection'; readonly tabId: string; readonly selected: boolean }
  /** Runs what the keyboard runs: the selection, or all of the text. */
  | {
      readonly type: 'editor:command';
      readonly tabId: string;
      readonly command: 'run' | 'runAll' | 'explain';
    }
  /**
   * Underlines spans of the tab's text as errors, such as the clause a SQL translation refused.
   * The editor drops the markers on the next change to the text.
   */
  | {
      readonly type: 'editor:markers';
      readonly tabId: string;
      readonly markers: readonly EditorMarker[];
    };

/** A span of the text, as offsets, with the message to show on hover. */
export interface EditorMarker {
  readonly start: number;
  readonly end: number;
  readonly message: string;
}

/** A marker as Monaco takes it, with one-based line and column numbers. */
export interface MarkerRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
  readonly message: string;
}

export const editorUiEvents = createUiEventBus<EditorUiEvent>('editor');

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

/** The one-based line and column of an offset in the text. */
function positionAt(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text.charAt(index) === '\n') {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/**
 * Turns offset markers into line and column ranges in the text. An offset past the end is clamped
 * to the end, and an empty span grows by one character, because a marker of zero width draws
 * nothing. A span that starts after it ends is swapped.
 */
export function markerRanges(text: string, markers: readonly EditorMarker[]): MarkerRange[] {
  return markers.map((marker) => {
    const low = Math.max(0, Math.min(marker.start, marker.end, text.length));
    const high = Math.max(0, Math.min(Math.max(marker.start, marker.end), text.length));
    const end = high > low ? high : Math.min(low + 1, text.length);
    const start = end > low ? low : Math.max(0, low - 1);
    const from = positionAt(text, start);
    const to = positionAt(text, end);
    return {
      startLineNumber: from.line,
      startColumn: from.column,
      endLineNumber: to.line,
      endColumn: to.column,
      message: marker.message,
    };
  });
}
