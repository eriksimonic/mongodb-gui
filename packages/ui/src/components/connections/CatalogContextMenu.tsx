import { Menu } from '@mantine/core';
import type { ConnectionStatus } from '@mongo-gui/core';
import { useAppStore } from '../../state/app-store-context';

export interface CatalogTarget {
  readonly connectionId: string;
  readonly database: string;
  /** Undefined for a database node. */
  readonly collection: string | undefined;
}

export interface CatalogContextMenuProps {
  readonly target: CatalogTarget;
  readonly status: ConnectionStatus;
  readonly position: { readonly x: number; readonly y: number };
  readonly onClose: () => void;
}

/** Right-click menu for a database or a collection. Import and export open their dialogs. */
export function CatalogContextMenu({ target, status, position, onClose }: CatalogContextMenuProps) {
  const setTransferDialog = useAppStore((state) => state.setTransferDialog);
  const connected = status.state === 'connected';

  function openImport() {
    onClose();
    setTransferDialog({
      kind: 'import',
      connectionId: target.connectionId,
      database: target.database,
      collection: target.collection,
    });
  }

  function openExport() {
    if (target.collection === undefined) {
      return;
    }
    onClose();
    setTransferDialog({
      kind: 'export',
      connectionId: target.connectionId,
      database: target.database,
      collection: target.collection,
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
        {target.collection === undefined ? (
          <Menu.Item disabled={!connected} onClick={openImport}>
            Import data into new collection
          </Menu.Item>
        ) : (
          <>
            <Menu.Item disabled={!connected} onClick={openImport}>
              Import data
            </Menu.Item>
            <Menu.Item disabled={!connected} onClick={openExport}>
              Export data
            </Menu.Item>
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
