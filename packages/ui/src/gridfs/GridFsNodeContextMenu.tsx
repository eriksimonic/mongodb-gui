import { TreeMenu, type TreeMenuEntry } from '../kit/TreeMenu';
import { runReported } from '../kit/notify-error';
import { useAppStore } from '../state/app-store-context';

export interface GridFsNodeContextMenuProps {
  readonly connectionId: string;
  readonly database: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly onClose: () => void;
}

/** Menu for the GridFS node of a database: add a bucket, or reload the bucket list. */
export function GridFsNodeContextMenu({
  connectionId,
  database,
  position,
  onClose,
}: GridFsNodeContextMenuProps) {
  const setGridFsDialog = useAppStore((state) => state.setGridFsDialog);
  const refreshGridFs = useAppStore((state) => state.refreshGridFs);
  const entries: TreeMenuEntry[] = [
    {
      kind: 'item',
      label: 'New GridFS bucket',
      onSelect: () => setGridFsDialog({ kind: 'newBucket', connectionId, database }),
    },
    {
      kind: 'item',
      label: 'Refresh',
      onSelect: () => {
        void runReported(() => refreshGridFs(connectionId, database));
      },
    },
  ];
  return <TreeMenu entries={entries} position={position} onClose={onClose} />;
}
