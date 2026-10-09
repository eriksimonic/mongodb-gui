import { Menu } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { useAppStore } from '../../state/app-store-context';
import { runReported } from '../notify-error';

export interface DockerNodeContextMenuProps {
  readonly autoConnect: boolean;
  readonly position: { readonly x: number; readonly y: number };
  readonly onClose: () => void;
}

/** Right-click menu for the Docker node. Holds the auto connect toggle. */
export function DockerNodeContextMenu({
  autoConnect,
  position,
  onClose,
}: DockerNodeContextMenuProps) {
  const setDockerAutoConnect = useAppStore((state) => state.setDockerAutoConnect);
  const loadDocker = useAppStore((state) => state.loadDocker);

  function runAndClose(action: () => Promise<void>) {
    onClose();
    void runReported(action);
  }

  return (
    <Menu opened withinPortal position="bottom-start" shadow="md" width={220} onClose={onClose}>
      <Menu.Target>
        <div
          style={{ position: 'fixed', left: position.x, top: position.y, width: 1, height: 1 }}
        />
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          rightSection={autoConnect ? <IconCheck size={14} aria-label="On" /> : undefined}
          onClick={() => runAndClose(() => setDockerAutoConnect(!autoConnect))}
        >
          Connect automatically
        </Menu.Item>
        <Menu.Item
          onClick={() => {
            onClose();
            void runReported(loadDocker);
          }}
        >
          Refresh
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
