/**
 * The tab menu entry that switches a SQL editor tab to its mongosh. It lives beside the
 * panels, as the close helpers do, so the component file exports only components.
 */
import { translateSql } from '@mongo-gui/core';
import type { TreeMenuEntry } from '../components/connections/TreeMenu';
import type { EditorTab } from '../state/editors';

/**
 * The "Open in Mongo" entry of a SQL tab. The entry is off, with the first error as its reason, when
 * the text does not translate. Selecting it runs the store action `openSqlAsMongo`, which samples
 * the field types and switches the tab to the mongosh. The SQL stays in the tab.
 */
export function convertEntries(tab: EditorTab, onSelect: () => void): TreeMenuEntry[] {
  const results = translateSql(tab.text);
  const failure = results.find((result) => !result.ok);
  const reason =
    tab.text.trim() === ''
      ? 'The tab is empty'
      : failure !== undefined && !failure.ok
        ? failure.error.message
        : results.length === 0
          ? 'The tab has no statement'
          : undefined;
  return [
    { kind: 'divider' },
    {
      kind: 'item',
      label: 'Open in Mongo',
      disabled: reason !== undefined,
      reason,
      onSelect,
    },
  ];
}
