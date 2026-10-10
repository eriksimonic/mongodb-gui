import { TreeMenu, type TreeMenuEntry } from '../connections/TreeMenu';
import { runReported } from '../notify-error';
import { useAppStore } from '../../state/app-store-context';
import { useGridFsOpener } from './gridfs-opener';

export interface GridFsBucketContextMenuProps {
  readonly connectionId: string;
  readonly database: string;
  readonly bucket: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly onClose: () => void;
}

/** Menu for a bucket node: open its files, upload a file, or drop it after a typed confirmation. */
export function GridFsBucketContextMenu({
  connectionId,
  database,
  bucket,
  position,
  onClose,
}: GridFsBucketContextMenuProps) {
  const uploadGridFsFile = useAppStore((state) => state.uploadGridFsFile);
  const setGridFsDialog = useAppStore((state) => state.setGridFsDialog);
  const gridfsOpener = useGridFsOpener();
  const entries: TreeMenuEntry[] = [
    {
      kind: 'item',
      label: 'Open',
      onSelect: () => gridfsOpener?.open(connectionId, database, bucket),
    },
    {
      kind: 'item',
      label: 'Upload file',
      onSelect: () => {
        void runReported(() => uploadGridFsFile(connectionId, database, bucket));
      },
    },
    {
      kind: 'item',
      label: 'Drop bucket',
      color: 'red',
      onSelect: () => setGridFsDialog({ kind: 'dropBucket', connectionId, database, bucket }),
    },
  ];
  return <TreeMenu entries={entries} position={position} onClose={onClose} />;
}
