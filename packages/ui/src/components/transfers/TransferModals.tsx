import { useAppStore } from '../../state/app-store-context';
import { ExportDialog } from './ExportDialog';
import { ImportWizard } from './ImportWizard';

/** Renders the import wizard or the export dialog that the store asks for. */
export function TransferModals() {
  const dialog = useAppStore((state) => state.transferDialog);
  const setDialog = useAppStore((state) => state.setTransferDialog);
  const close = () => {
    setDialog({ kind: 'closed' });
  };
  if (dialog.kind === 'import') {
    return (
      <ImportWizard
        connectionId={dialog.connectionId}
        database={dialog.database}
        collection={dialog.collection}
        onClose={close}
      />
    );
  }
  if (dialog.kind === 'export') {
    return (
      <ExportDialog
        connectionId={dialog.connectionId}
        database={dialog.database}
        collection={dialog.collection}
        onClose={close}
      />
    );
  }
  return null;
}
