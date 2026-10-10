import { Button, Group, Modal } from '@mantine/core';
import { useBackupDialogs, type BackupDialogRequest } from './backup-dialog-store';

export interface BackupDialogProps {
  readonly request: Extract<BackupDialogRequest, { kind: 'backup' }>;
}

/** The backup dialog. This is a shell that the backup dialog task replaces. */
export function BackupDialog({ request }: BackupDialogProps) {
  const close = useBackupDialogs((state) => state.close);
  const target = request.collection ?? request.database ?? 'connection';
  return (
    <Modal opened onClose={close} title={`Back up ${target}`} size="xl" centered>
      <Group justify="flex-end">
        <Button variant="default" onClick={close}>
          Cancel
        </Button>
      </Group>
    </Modal>
  );
}
