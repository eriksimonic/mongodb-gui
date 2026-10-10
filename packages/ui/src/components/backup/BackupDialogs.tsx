import { BackupDialog } from './BackupDialog';
import { useBackupDialogs } from './backup-dialog-store';
import { RestoreDialog } from './RestoreDialog';

/** Renders the backup or restore dialog while the store holds a request. */
export function BackupDialogs() {
  const request = useBackupDialogs((state) => state.request);
  if (request === undefined) {
    return null;
  }
  if (request.kind === 'backup') {
    return (
      <BackupDialog
        key={`backup/${request.connectionId}/${request.database ?? ''}/${request.collection ?? ''}`}
        request={request}
      />
    );
  }
  return (
    <RestoreDialog
      key={`restore/${request.connectionId}/${request.database ?? ''}`}
      request={request}
    />
  );
}
