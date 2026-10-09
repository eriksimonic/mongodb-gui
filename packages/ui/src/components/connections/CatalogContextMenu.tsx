import { useProfilerOpener } from '../../profiler/profiler-opener';
import { useAppStore } from '../../state/app-store-context';
import { TreeMenu, type TreeMenuEntry } from './TreeMenu';

interface MenuPlacement {
  readonly position: { readonly x: number; readonly y: number };
  readonly onClose: () => void;
}

export interface DatabaseContextMenuProps extends MenuPlacement {
  readonly connectionId: string;
  readonly database: string;
}

/** Menu for a database node. Creating and dropping go through dialogs that the shell shows. */
export function DatabaseContextMenu({
  connectionId,
  database,
  position,
  onClose,
}: DatabaseContextMenuProps) {
  const setManagementDialog = useAppStore((state) => state.setManagementDialog);
  const refreshDatabase = useAppStore((state) => state.refreshDatabase);
  const profilerOpener = useProfilerOpener();
  const openEditor = useAppStore((state) => state.openEditor);
  const entries: TreeMenuEntry[] = [
    {
      kind: 'item',
      label: 'Open editor',
      onSelect: () => openEditor({ connectionId, database }),
    },
    {
      kind: 'item',
      label: 'New collection',
      onSelect: () => setManagementDialog({ kind: 'createCollection', connectionId, database }),
    },
    {
      kind: 'item',
      label: 'Open profiler',
      onSelect: () => profilerOpener?.open(connectionId, database),
    },
    {
      kind: 'item',
      label: 'Drop database',
      color: 'red',
      onSelect: () => setManagementDialog({ kind: 'dropDatabase', connectionId, database }),
    },
    {
      kind: 'item',
      label: 'Refresh',
      onSelect: () => refreshDatabase(connectionId, database),
    },
  ];
  return <TreeMenu entries={entries} position={position} onClose={onClose} />;
}

export interface CollectionContextMenuProps extends MenuPlacement {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
}

/** Menu for a collection node. Panels open in the dock. Destructive actions open a confirmation. */
export function CollectionContextMenu({
  connectionId,
  database,
  collection,
  position,
  onClose,
}: CollectionContextMenuProps) {
  const requestPanel = useAppStore((state) => state.requestPanel);
  const setManagementDialog = useAppStore((state) => state.setManagementDialog);
  const refreshDatabase = useAppStore((state) => state.refreshDatabase);
  const target = { connectionId, database, collection };
  const entries: TreeMenuEntry[] = [
    {
      kind: 'item',
      label: 'Open documents',
      onSelect: () => requestPanel({ panel: 'documents', ...target }),
    },
    {
      kind: 'item',
      label: 'Indexes',
      onSelect: () => requestPanel({ panel: 'indexes', ...target }),
    },
    {
      kind: 'item',
      label: 'Validation',
      onSelect: () => requestPanel({ panel: 'validation', ...target }),
    },
    {
      kind: 'item',
      label: 'Rename',
      onSelect: () => setManagementDialog({ kind: 'renameCollection', ...target }),
    },
    {
      kind: 'item',
      label: 'Clear',
      onSelect: () => setManagementDialog({ kind: 'clearCollection', ...target }),
    },
    {
      kind: 'item',
      label: 'Drop',
      color: 'red',
      onSelect: () => setManagementDialog({ kind: 'dropCollection', ...target }),
    },
    {
      kind: 'item',
      label: 'Refresh',
      onSelect: () => refreshDatabase(connectionId, database),
    },
  ];
  return <TreeMenu entries={entries} position={position} onClose={onClose} />;
}
