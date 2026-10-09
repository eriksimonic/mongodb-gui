import { Box, Menu } from '@mantine/core';
import { useProfilerOpener } from '../../profiler/profiler-opener';

export interface DatabaseContextMenuProps {
  readonly connectionId: string;
  readonly database: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly onClose: () => void;
}

/** Right-click menu for a database. Opens at the pointer and closes after one action. */
export function DatabaseContextMenu({
  connectionId,
  database,
  position,
  onClose,
}: DatabaseContextMenuProps) {
  const opener = useProfilerOpener();

  return (
    <Menu opened withinPortal position="bottom-start" shadow="md" width={180} onClose={onClose}>
      <Menu.Target>
        <Box
          style={{ position: 'fixed', left: position.x, top: position.y, width: 1, height: 1 }}
        />
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          onClick={() => {
            onClose();
            opener?.open(connectionId, database);
          }}
        >
          Open profiler
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
