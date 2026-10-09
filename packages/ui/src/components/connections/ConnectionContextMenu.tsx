import { Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import type { ConnectionProfileSummary, ConnectionStatus } from '@mongo-gui/core';
import { useAppStore } from '../../state/app-store-context';
import { runReported } from '../notify-error';
import { TreeMenu, type TreeMenuEntry } from './TreeMenu';

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
  const canConnect = status.state === 'disconnected' || status.state === 'error';
  const canDisconnect = status.state === 'connected' || status.state === 'connecting';

  function confirmRemove() {
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

  const entries: TreeMenuEntry[] = [
    {
      kind: 'item',
      label: 'Connect',
      disabled: !canConnect,
      onSelect: () => void runReported(() => connect(connection.id)),
    },
    {
      kind: 'item',
      label: 'Disconnect',
      disabled: !canDisconnect,
      onSelect: () => void runReported(() => disconnect(connection.id)),
    },
    {
      kind: 'item',
      label: 'New database',
      disabled: status.state !== 'connected',
      onSelect: () => setManagementDialog({ kind: 'createDatabase', connectionId: connection.id }),
    },
    {
      kind: 'item',
      label: 'Edit',
      onSelect: () => setDialog({ kind: 'edit', connectionId: connection.id }),
    },
    {
      kind: 'item',
      label: 'Refresh',
      onSelect: () => refreshConnection(connection.id),
    },
    { kind: 'divider' },
    { kind: 'item', label: 'Remove', color: 'red', onSelect: confirmRemove },
  ];

  return <TreeMenu entries={entries} position={position} onClose={onClose} />;
}
