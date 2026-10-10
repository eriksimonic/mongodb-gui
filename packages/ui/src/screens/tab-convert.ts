/**
 * The tab menu entry that converts a SQL editor tab to mongosh. It lives beside the panels, as the
 * close helpers do, so the component file exports only components.
 */
import { translateSql } from '@mongo-gui/core';
import type { TreeMenuEntry } from '../components/connections/TreeMenu';
import type { EditorTab } from '../state/editors';

/**
 * The "Convert to mongosh" entry of a SQL tab. The entry is off, with the first error as its
 * reason, when the text does not translate. Selecting it runs the same store action as the language
 * toggle, `setEditorLanguage`, which samples the field types and keeps the SQL for a way back.
 */
export function convertEntries(tab: EditorTab, onSelect: () => void): TreeMenuEntry[] {
  const failure = translateSql(tab.text).find((result) => !result.ok);
  const reason =
    tab.text.trim() === ''
      ? 'The tab is empty'
      : failure !== undefined && !failure.ok
        ? failure.error.message
        : undefined;
  return [
    { kind: 'divider' },
    {
      kind: 'item',
      label: 'Convert to mongosh',
      disabled: reason !== undefined,
      reason,
      onSelect,
    },
  ];
}
