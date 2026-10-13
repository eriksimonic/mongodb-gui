import { useAppStore } from '../state/app-store-context';
import { lazy, Suspense } from 'react';

// The dialogs are large and rarely open, so they load on first use.
const ExportDialog = lazy(() =>
  import('./ExportDialog').then((module) => ({ default: module.ExportDialog })),
);
const ImportWizard = lazy(() =>
  import('./ImportWizard').then((module) => ({ default: module.ImportWizard })),
);

/** Renders the import wizard or the export dialog that the store asks for. */
export function TransferModals() {
  const dialog = useAppStore((state) => state.transferDialog);
  const setDialog = useAppStore((state) => state.setTransferDialog);
  const close = () => {
    setDialog({ kind: 'closed' });
  };
  if (dialog.kind === 'import') {
    return (
      <Suspense fallback={null}>
        <ImportWizard
          connectionId={dialog.connectionId}
          database={dialog.database}
          collection={dialog.collection}
          onClose={close}
        />
      </Suspense>
    );
  }
  if (dialog.kind === 'export') {
    return (
      <Suspense fallback={null}>
        <ExportDialog
          connectionId={dialog.connectionId}
          database={dialog.database}
          collection={dialog.collection}
          onClose={close}
        />
      </Suspense>
    );
  }
  return null;
}
