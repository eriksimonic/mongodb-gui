import { Alert, Button, Loader, Stack, Text } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { ConnectionStatus } from '@mongo-gui/core';
import type { Selection } from '../../state/app-store';
import { useAppStore } from '../../state/app-store-context';
import { catalogKey, connectionNodeId, databaseNodeId } from '../../state/node-ids';
import { ConnectionContextMenu } from './ConnectionContextMenu';
import { TreeMessage, TreeRow } from './TreeRow';
import {
  buildTreeRows,
  edgeFocusKey,
  firstChildKey,
  focusableRows,
  nextFocusKey,
  parentKeyOf,
  type TreeRow as TreeRowModel,
} from './tree-model';

const DISCONNECTED: ConnectionStatus = { state: 'disconnected' };

interface MenuAnchor {
  readonly connectionId: string;
  readonly x: number;
  readonly y: number;
}

function selectionFor(row: TreeRowModel): Selection | undefined {
  if (row.kind === 'message') {
    return undefined;
  }
  return {
    connectionId: row.connectionId,
    database: row.database,
    collection: row.collection,
  };
}

function isSelected(row: TreeRowModel, selection: Selection | undefined): boolean {
  if (selection === undefined || selection.connectionId !== row.connectionId) {
    return false;
  }
  if (row.kind === 'connection') {
    return selection.database === undefined;
  }
  if (row.kind === 'database') {
    return selection.database === row.database && selection.collection === undefined;
  }
  return row.kind === 'collection' && selection.collection === row.collection;
}

function canConnect(status: ConnectionStatus | undefined): boolean {
  return status === undefined || status.state === 'disconnected' || status.state === 'error';
}

/**
 * The Connections panel. A flat `role="tree"` with roving focus. Arrow keys move, Right and Left
 * expand and collapse, Enter opens, Shift+F10 or the menu key opens the context menu.
 */
export function ConnectionTree() {
  const connections = useAppStore((state) => state.connections);
  const statuses = useAppStore((state) => state.statuses);
  const expanded = useAppStore((state) => state.expanded);
  const databases = useAppStore((state) => state.databases);
  const collections = useAppStore((state) => state.collections);
  const selection = useAppStore((state) => state.selection);
  const setDialog = useAppStore((state) => state.setDialog);
  const setNodeExpanded = useAppStore((state) => state.setNodeExpanded);
  const expandConnection = useAppStore((state) => state.expandConnection);
  const connect = useAppStore((state) => state.connect);
  const loadDatabases = useAppStore((state) => state.loadDatabases);
  const loadCollections = useAppStore((state) => state.loadCollections);
  const select = useAppStore((state) => state.select);
  const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
  const [menu, setMenu] = useState<MenuAnchor | undefined>(undefined);
  const items = useRef(new Map<string, HTMLDivElement>());
  const list = connections.state === 'ready' ? connections.data : undefined;

  const rows = useMemo(
    () =>
      list === undefined
        ? []
        : buildTreeRows({ connections: list, statuses, expanded, databases, collections }),
    [list, statuses, expanded, databases, collections],
  );

  useEffect(() => {
    if (list === undefined) {
      return;
    }
    for (const connection of list) {
      if (expanded[connectionNodeId(connection.id)] !== true) {
        continue;
      }
      if (statuses[connection.id]?.state !== 'connected') {
        continue;
      }
      const loaded = databases[connection.id];
      if (loaded === undefined) {
        void loadDatabases(connection.id);
      }
      if (loaded?.state !== 'ready') {
        continue;
      }
      for (const database of loaded.data) {
        const open = expanded[databaseNodeId(connection.id, database.name)] === true;
        if (open && collections[catalogKey(connection.id, database.name)] === undefined) {
          void loadCollections(connection.id, database.name);
        }
      }
    }
  }, [list, statuses, expanded, databases, collections, loadDatabases, loadCollections]);

  if (connections.state === 'loading') {
    return <Loader size="xs" aria-label="Loading connections" />;
  }
  if (connections.state === 'error') {
    return (
      <Alert color="red" variant="light" p="xs">
        {connections.error.message}
      </Alert>
    );
  }
  if (connections.data.length === 0) {
    return (
      <Stack gap="xs" align="flex-start">
        <Text size="sm" c="dimmed">
          No connections yet.
        </Text>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() => setDialog({ kind: 'create' })}
        >
          New connection
        </Button>
      </Stack>
    );
  }

  const focusable = focusableRows(rows);
  const activeKey = focusable.some((row) => row.key === focusKey) ? focusKey : focusable[0]?.key;
  const menuConnection =
    menu === undefined ? undefined : connections.data.find((item) => item.id === menu.connectionId);

  function focusRow(key: string) {
    setFocusKey(key);
    items.current.get(key)?.focus();
  }

  function expandRow(row: TreeRowModel) {
    if (row.kind === 'connection') {
      void expandConnection(row.connectionId);
    } else {
      setNodeExpanded(row.key, true);
    }
  }

  function toggleRow(row: TreeRowModel) {
    if (row.expanded) {
      setNodeExpanded(row.key, false);
    } else {
      expandRow(row);
    }
  }

  function selectRow(row: TreeRowModel) {
    const next = selectionFor(row);
    if (next !== undefined) {
      select(next);
    }
  }

  /** Enter opens a collapsed connection, which also connects it. On an open one it connects if needed. */
  function openRow(row: TreeRowModel) {
    selectRow(row);
    if (row.kind !== 'connection') {
      return;
    }
    if (!row.expanded) {
      expandRow(row);
    } else if (canConnect(statuses[row.connectionId])) {
      void connect(row.connectionId);
    }
  }

  function openMenuFor(row: TreeRowModel) {
    if (row.kind !== 'connection') {
      return;
    }
    const rect = items.current.get(row.key)?.getBoundingClientRect();
    setMenu({
      connectionId: row.connectionId,
      x: rect === undefined ? 0 : rect.left + 12,
      y: rect === undefined ? 0 : rect.bottom,
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // The key event belongs to the row that has focus, so that row is the one to act on.
    const targetKey =
      event.target instanceof Element
        ? event.target.closest('[data-key]')?.getAttribute('data-key')
        : undefined;
    const row = rows.find((item) => item.key === (targetKey ?? activeKey));
    if (row === undefined) {
      return;
    }
    let target: string | undefined;
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      openMenuFor(row);
    } else if (event.key === 'ArrowDown') {
      target = nextFocusKey(rows, row.key, 1);
    } else if (event.key === 'ArrowUp') {
      target = nextFocusKey(rows, row.key, -1);
    } else if (event.key === 'Home') {
      target = edgeFocusKey(rows, 'first');
    } else if (event.key === 'End') {
      target = edgeFocusKey(rows, 'last');
    } else if (event.key === 'ArrowRight') {
      if (row.expandable && !row.expanded) {
        expandRow(row);
      } else {
        target = firstChildKey(rows, row.key);
      }
    } else if (event.key === 'ArrowLeft') {
      if (row.expandable && row.expanded) {
        setNodeExpanded(row.key, false);
      } else {
        target = parentKeyOf(rows, row.key);
      }
    } else if (event.key === 'Enter') {
      openRow(row);
    } else {
      return;
    }
    event.preventDefault();
    if (target !== undefined) {
      focusRow(target);
    }
  }

  function handleContextMenu(row: TreeRowModel, event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    if (row.kind === 'connection') {
      setMenu({ connectionId: row.connectionId, x: event.clientX, y: event.clientY });
    }
  }

  return (
    <div role="tree" aria-label="Connections" className="mg-tree" onKeyDown={handleKeyDown}>
      {rows.map((row) =>
        row.kind === 'message' ? (
          <TreeMessage key={row.key} row={row} />
        ) : (
          <TreeRow
            key={row.key}
            row={row}
            focused={row.key === activeKey}
            selected={isSelected(row, selection)}
            setRef={(key, element) => {
              if (element === null) {
                items.current.delete(key);
              } else {
                items.current.set(key, element);
              }
            }}
            onFocusRow={setFocusKey}
            onToggle={() => toggleRow(row)}
            onSelect={() => selectRow(row)}
            onDoubleClick={() => {
              if (row.kind === 'connection' && canConnect(statuses[row.connectionId])) {
                void connect(row.connectionId);
              }
            }}
            onContextMenu={(event) => handleContextMenu(row, event)}
          />
        ),
      )}
      {menu === undefined || menuConnection === undefined ? null : (
        <ConnectionContextMenu
          connection={menuConnection}
          status={statuses[menu.connectionId] ?? DISCONNECTED}
          position={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  );
}
