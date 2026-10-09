import { openTab, EMPTY_EDITORS, type EditorsState, type ResultView } from '../state/editors';

export const EDITOR_TAB_ID = '6b0f6f2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

/** An editors slice with one tab open on the connection and database, for component tests. */
export function editorStateWith(
  connectionId: string,
  database: string,
  options: { readonly text?: string; readonly view?: ResultView } = {},
): EditorsState {
  return openTab(EMPTY_EDITORS, {
    id: EDITOR_TAB_ID,
    connectionId,
    database,
    text: options.text ?? '',
    ...(options.view === undefined ? {} : { view: options.view }),
  });
}
