import { Menu, Text } from '@mantine/core';
import { useBackupDialogs } from './backup-dialog-store';

export interface BackupMenuItemsProps {
  /** The saved connection to back up or restore into. Undefined disables both items. */
  readonly connectionId: string | undefined;
  readonly connected: boolean;
  /** Closes the menu before the dialog opens. */
  readonly onClose: () => void;
}

/** "Back up…" and "Restore…" for a connection menu. Both need a connected connection. */
export function BackupMenuItems({ connectionId, connected, onClose }: BackupMenuItemsProps) {
  const enabled = connected && connectionId !== undefined;
  const reason = enabled ? undefined : (
    <Text size="xs" c="dimmed">
      Not connected
    </Text>
  );

  function open(kind: 'backup' | 'restore') {
    onClose();
    if (connectionId !== undefined) {
      useBackupDialogs.getState().open({ kind, connectionId });
    }
  }

  return (
    <>
      <Menu.Item disabled={!enabled} rightSection={reason} onClick={() => open('backup')}>
        Back up…
      </Menu.Item>
      <Menu.Item disabled={!enabled} rightSection={reason} onClick={() => open('restore')}>
        Restore…
      </Menu.Item>
    </>
  );
}
