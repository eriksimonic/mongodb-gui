import { Box, Menu, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import type { ConnectionProfileSummary, ConnectionStatus } from '@mongo-gui/core';
import { useAppStore } from '../../state/app-store-context';
import { usePanelOpener } from '../../state/panel-opener';
import { runReported } from '../notify-error';

export interface ConnectionContextMenuProps {
  readonly connection: ConnectionProfileSummary;
  readonly status: ConnectionStatus;
  readonly position: { readonly x: number; readonly y: number };
  readonly onClose: () => void;
}

/** Right-click menu for a connection. Opens at the pointer and closes after one action. */
export function ConnectionContextMenu({
  connection,
  status,
  position,
  onClose,
}: ConnectionContextMenuProps) {
  const connect = useAppStore((state) => state.connect);
  const disconnect = useAppStore((state) => state.disconnect);
  const removeConnection = useAppStore((state) => state.removeConnection);
  const refreshConnection = useAppStore((state) => state.refreshConnection);
  const setDialog = useAppStore((state) => state.setDialog);
  const setManagementDialog = useAppStore((state) => state.setManagementDialog);
  const openPanel = usePanelOpener();
  const openEditor = useAppStore((state) => state.openEditor);
  const loadedDatabases = useAppStore((state) => state.databases[connection.id]);
  const canConnect = status.state === 'disconnected' || status.state === 'error';
  const canDisconnect = status.state === 'connected' || status.state === 'connecting';

  function runAndClose(action: () => Promise<void>) {
    onClose();
    void runReported(action);
  }

  function confirmRemove() {
    onClose();
    modals.openConfirmModal({
      title: 'Remove connection',
      centered: true,
      children: (
        <Text size="sm">
          Remove {connection.name}? Its saved URI is deleted. This cannot be undone.
        </Text>
      ),
      labels: { confirm: 'Remove', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        void runReported(() => removeConnection(connection.id));
      },
    });
  }

  return (
    <Menu opened withinPortal position="bottom-start" shadow="md" width={180} onClose={onClose}>
      <Menu.Target>
        <Box
          style={{ position: 'fixed', left: position.x, top: position.y, width: 1, height: 1 }}
        />
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item disabled={!canConnect} onClick={() => runAndClose(() => connect(connection.id))}>
          Connect
        </Menu.Item>
        <Menu.Item
          disabled={!canDisconnect}
          onClick={() => runAndClose(() => disconnect(connection.id))}
        >
          Disconnect
        </Menu.Item>
        <Menu.Item
          disabled={status.state !== 'connected'}
          onClick={() => {
            onClose();
            openPanel({
              kind: 'monitor',
              connectionId: connection.id,
              connectionName: connection.name,
            });
          }}
        >
          Monitor
        </Menu.Item>
        <Menu.Item
          disabled={status.state !== 'connected'}
          onClick={() => {
            onClose();
            setManagementDialog({ kind: 'createDatabase', connectionId: connection.id });
          }}
        >
          New database
        </Menu.Item>
        <Menu.Item
          onClick={() => {
            onClose();
            const first =
              loadedDatabases?.state === 'ready' ? loadedDatabases.data[0]?.name : undefined;
            openEditor({ connectionId: connection.id, database: first ?? 'admin', newTab: true });
          }}
        >
          Open editor
        </Menu.Item>
        <Menu.Item
          onClick={() => {
            onClose();
            setDialog({ kind: 'edit', connectionId: connection.id });
          }}
        >
          Edit
        </Menu.Item>
        <Menu.Item
          onClick={() => {
            onClose();
            refreshConnection(connection.id);
          }}
        >
          Refresh
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item color="red" onClick={confirmRemove}>
          Remove
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
