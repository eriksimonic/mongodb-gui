import { useAppStore } from '../../state/app-store-context';
import { ClearCollectionDialog, DropCollectionDialog, DropDatabaseDialog } from './DropDialogs';
import { CreateCollectionDialog } from './CreateCollectionDialog';
import { CreateDatabaseDialog } from './CreateDatabaseDialog';
import { CreateIndexDialog } from './CreateIndexDialog';
import { RenameCollectionDialog } from './RenameCollectionDialog';

export interface ManagementDialogsProps {
  /** Called once a database is dropped, so the shell can close the panels that show it. */
  readonly onDatabaseDropped?: ((connectionId: string, database: string) => void) | undefined;
}

/** Shows the management dialog the store names, if one is open. The tree opens them. */
export function ManagementDialogs({ onDatabaseDropped }: ManagementDialogsProps) {
  const dialog = useAppStore((state) => state.managementDialog);
  const setManagementDialog = useAppStore((state) => state.setManagementDialog);
  if (dialog === undefined) {
    return null;
  }
  const onClose = () => setManagementDialog(undefined);
  switch (dialog.kind) {
    case 'createDatabase':
      return <CreateDatabaseDialog connectionId={dialog.connectionId} onClose={onClose} />;
    case 'createCollection':
      return (
        <CreateCollectionDialog
          connectionId={dialog.connectionId}
          database={dialog.database}
          onClose={onClose}
        />
      );
    case 'renameCollection':
      return (
        <RenameCollectionDialog
          connectionId={dialog.connectionId}
          database={dialog.database}
          collection={dialog.collection}
          onClose={onClose}
        />
      );
    case 'clearCollection':
      return (
        <ClearCollectionDialog
          connectionId={dialog.connectionId}
          database={dialog.database}
          collection={dialog.collection}
          onClose={onClose}
        />
      );
    case 'dropCollection':
      return (
        <DropCollectionDialog
          connectionId={dialog.connectionId}
          database={dialog.database}
          collection={dialog.collection}
          onClose={onClose}
        />
      );
    case 'createIndex':
      return (
        <CreateIndexDialog
          connectionId={dialog.connectionId}
          database={dialog.database}
          collection={dialog.collection}
          initialField={dialog.field}
          onClose={onClose}
        />
      );
    case 'dropDatabase':
      return (
        <DropDatabaseDialog
          connectionId={dialog.connectionId}
          database={dialog.database}
          onClose={onClose}
          onDropped={() => onDatabaseDropped?.(dialog.connectionId, dialog.database)}
        />
      );
  }
}
