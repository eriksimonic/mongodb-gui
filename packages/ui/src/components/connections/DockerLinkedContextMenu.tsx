import { Menu } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import type {
  ConnectionProfileSummary,
  ConnectionStatus,
  DockerMongoContainerSummary,
} from '@mongo-gui/core';
import { runReported } from '../../kit/notify-error';
import { ConnectionContextMenu } from './ConnectionContextMenu';
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

/**
 * Right-click menu for a container that already has a connection. The shared connection menu
 * supplies every common action, so the two cannot drift apart.
 */
export function DockerLinkedContextMenu({
  connection,
  container,
  status,
  position,
  onClose,
}: DockerLinkedContextMenuProps) {
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
    <ConnectionContextMenu
      connection={connection}
      status={status}
      position={position}
      onClose={onClose}
      // A missing container has nothing to connect to, so Connect stays off until it is back.
      connectDisabled={container === undefined}
      extraItems={
        <>
          <Menu.Divider />
          <Menu.Item onClick={copyRedactedUri}>Copy URI (redacted)</Menu.Item>
          <Menu.Item disabled={container === undefined} onClick={openDetails}>
            Open container details
          </Menu.Item>
        </>
      }
    />
  );
}
