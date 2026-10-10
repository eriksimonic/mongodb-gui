import { Button, Group, Modal } from '@mantine/core';
import { useBackupDialogs, type BackupDialogRequest } from './backup-dialog-store';

export interface RestoreDialogProps {
  readonly request: Extract<BackupDialogRequest, { kind: 'restore' }>;
}

/** The restore dialog. This is a shell that the restore dialog task replaces. */
export function RestoreDialog({ request }: RestoreDialogProps) {
  const close = useBackupDialogs((state) => state.close);
  return (
    <Modal
      opened
      onClose={close}
      title={`Restore into ${request.database ?? 'connection'}`}
      size="xl"
      centered
    >
      <Group justify="flex-end">
        <Button variant="default" onClick={close}>
          Cancel
        </Button>
      </Group>
    </Modal>
  );
}
