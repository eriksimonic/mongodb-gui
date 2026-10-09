import { Menu, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import type {
  ConnectionProfileSummary,
  ConnectionStatus,
  DockerMongoContainerSummary,
} from '@mongo-gui/core';
import { useAppStore } from '../../state/app-store-context';
import { runReported } from '../notify-error';
import { DockerContainerDetails } from './DockerContainerDetails';

export interface DockerLinkedContextMenuProps {
  /** The saved docker profile. It has the same actions as any connection, plus container details. */
  readonly connection: ConnectionProfileSummary;
  /** The container, when it is in the current list. A missing container disables its details. */
  readonly container: DockerMongoContainerSummary | undefined;
  readonly status: ConnectionStatus;
  readonly position: { readonly x: number; readonly y: number };
  readonly onClose: () => void;
}

/** Right-click menu for a container that already has a connection. */
export function DockerLinkedContextMenu({
  connection,
  container,
  status,
  position,
  onClose,
}: DockerLinkedContextMenuProps) {
  const connect = useAppStore((state) => state.connect);
  const disconnect = useAppStore((state) => state.disconnect);
  const removeConnection = useAppStore((state) => state.removeConnection);
  const refreshConnection = useAppStore((state) => state.refreshConnection);
  const setDialog = useAppStore((state) => state.setDialog);
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

  function copyRedactedUri() {
    onClose();
    void runReported(async () => {
      await navigator.clipboard.writeText(connection.uriRedacted);
      notifications.show({ title: 'Copied', message: 'The redacted URI is on the clipboard.' });
    });
  }

  function openDetails() {
    onClose();
    if (container === undefined) {
      return;
    }
    modals.open({
      title: 'Container details',
      centered: true,
      children: <DockerContainerDetails container={container} />,
    });
  }

  return (
    <Menu opened withinPortal position="bottom-start" shadow="md" width={220} onClose={onClose}>
      <Menu.Target>
        <div
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
        <Menu.Item color="red" onClick={confirmRemove}>
          Remove
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item onClick={copyRedactedUri}>Copy URI (redacted)</Menu.Item>
        <Menu.Item disabled={container === undefined} onClick={openDetails}>
          Open container details
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
