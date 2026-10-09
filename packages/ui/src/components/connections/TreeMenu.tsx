import { Box, Menu } from '@mantine/core';

export type TreeMenuEntry =
  | {
      readonly kind: 'item';
      readonly label: string;
      readonly disabled?: boolean;
      readonly color?: string;
      readonly onSelect: () => void;
    }
  | { readonly kind: 'divider' };

export interface TreeMenuProps {
  readonly entries: readonly TreeMenuEntry[];
  readonly position: { readonly x: number; readonly y: number };
  readonly onClose: () => void;
}

/**
 * The popup menu for a tree row. It opens at the pointer and closes after one item runs. Each
 * item runs after the menu closes, so a dialog it opens is not hidden by the menu.
 */
export function TreeMenu({ entries, position, onClose }: TreeMenuProps) {
  return (
    <Menu opened withinPortal position="bottom-start" shadow="md" width={200} onClose={onClose}>
      <Menu.Target>
        <Box
          style={{ position: 'fixed', left: position.x, top: position.y, width: 1, height: 1 }}
        />
      </Menu.Target>
      <Menu.Dropdown>
        {entries.map((entry, index) =>
          entry.kind === 'divider' ? (
            <Menu.Divider key={`divider-${index}`} />
          ) : (
            <Menu.Item
              key={entry.label}
              disabled={entry.disabled ?? false}
              {...(entry.color === undefined ? {} : { color: entry.color })}
              onClick={() => {
                onClose();
                entry.onSelect();
              }}
            >
              {entry.label}
            </Menu.Item>
          ),
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
