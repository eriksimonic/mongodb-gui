import { lazy, Suspense } from 'react';
import { useBackupDialogs } from './backup-dialog-store';

// The dialogs are large and rarely open, so they load on first use.
const BackupDialog = lazy(() =>
  import('./BackupDialog').then((module) => ({ default: module.BackupDialog })),
);
const RestoreDialog = lazy(() =>
  import('./RestoreDialog').then((module) => ({ default: module.RestoreDialog })),
);

/** Renders the backup or restore dialog while the store holds a request. */
export function BackupDialogs() {
  const request = useBackupDialogs((state) => state.request);
  if (request === undefined) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      {request.kind === 'backup' ? (
        <BackupDialog
          key={`backup/${request.connectionId}/${request.database ?? ''}/${request.collection ?? ''}`}
          request={request}
        />
      ) : (
        <RestoreDialog
          key={`restore/${request.connectionId}/${request.database ?? ''}`}
          request={request}
        />
      )}
    </Suspense>
  );
}
