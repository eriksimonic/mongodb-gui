import { Menu } from '@mantine/core';
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

export interface DockerContainerContextMenuProps {
  readonly container: DockerMongoContainerSummary;
  /** The saved connection for this container, once it has one. */
  readonly profile: ConnectionProfileSummary | undefined;
  readonly status: ConnectionStatus | undefined;
  readonly position: { readonly x: number; readonly y: number };
  readonly onClose: () => void;
}

/** Right-click menu for a discovered container. Opens at the pointer and closes after one action. */
export function DockerContainerContextMenu({
  container,
  profile,
  status,
  position,
  onClose,
}: DockerContainerContextMenuProps) {
  const connectContainer = useAppStore((state) => state.connectContainer);
  const disconnectContainer = useAppStore((state) => state.disconnectContainer);
  const canConnect =
    status === undefined || status.state === 'disconnected' || status.state === 'error';
  const canDisconnect = status?.state === 'connected' || status?.state === 'connecting';

  function runAndClose(action: () => Promise<void>) {
    onClose();
    void runReported(action);
  }

  function copyRedactedUri() {
    onClose();
    if (profile === undefined) {
      return;
    }
    void runReported(async () => {
      await navigator.clipboard.writeText(profile.uriRedacted);
      notifications.show({ title: 'Copied', message: 'The redacted URI is on the clipboard.' });
    });
  }

  function openDetails() {
    onClose();
    modals.open({
      title: 'Container details',
      centered: true,
      children: <DockerContainerDetails container={container} />,
    });
  }

  return (
    <Menu opened withinPortal position="bottom-start" shadow="md" width={200} onClose={onClose}>
      <Menu.Target>
        <div
          style={{ position: 'fixed', left: position.x, top: position.y, width: 1, height: 1 }}
        />
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          disabled={!canConnect}
          onClick={() => runAndClose(() => connectContainer(container.id))}
        >
          Connect
        </Menu.Item>
        <Menu.Item
          disabled={!canDisconnect}
          onClick={() => runAndClose(() => disconnectContainer(container.id))}
        >
          Disconnect
        </Menu.Item>
        <Menu.Item disabled={profile === undefined} onClick={copyRedactedUri}>
          Copy URI (redacted)
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item onClick={openDetails}>Open container details</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
