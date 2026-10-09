import { ColorSwatch, Stack } from '@mantine/core';
import type { ConnectionProfileSummary, ConnectionStatus, DatabaseInfo } from '@mongo-gui/core';
import { useEffect, useState, type MouseEvent } from 'react';
import type { Loadable } from '../../state/app-store';
import { useAppStore } from '../../state/app-store-context';
import { connectionNodeId } from '../../state/node-ids';
import { ConnectionContextMenu } from './ConnectionContextMenu';
import { ConnectionStatusIcon } from './ConnectionStatusIcon';
import { DatabaseNode } from './DatabaseNode';
import { TreeMessage, TreeRow } from './TreeRow';

const DISCONNECTED: ConnectionStatus = { state: 'disconnected' };

export interface ConnectionNodeProps {
  readonly connection: ConnectionProfileSummary;
}

interface MenuPosition {
  readonly x: number;
  readonly y: number;
}

/** A connection in the tree. Expanding it connects and then lists its databases. */
export function ConnectionNode({ connection }: ConnectionNodeProps) {
  const { id, name, color } = connection;
  const nodeId = connectionNodeId(id);
  const expanded = useAppStore((state) => state.expanded[nodeId] === true);
  const status = useAppStore((state) => state.statuses[id] ?? DISCONNECTED);
  const databases = useAppStore((state) => state.databases[id]);
  const selected = useAppStore(
    (state) => state.selection?.connectionId === id && state.selection.database === undefined,
  );
  const setNodeExpanded = useAppStore((state) => state.setNodeExpanded);
  const expandConnection = useAppStore((state) => state.expandConnection);
  const connect = useAppStore((state) => state.connect);
  const loadDatabases = useAppStore((state) => state.loadDatabases);
  const select = useAppStore((state) => state.select);
  const [menuAt, setMenuAt] = useState<MenuPosition | undefined>(undefined);

  useEffect(() => {
    if (expanded && status.state === 'connected' && databases === undefined) {
      void loadDatabases(id);
    }
  }, [expanded, status.state, databases, id, loadDatabases]);

  function toggle() {
    if (expanded) {
      setNodeExpanded(nodeId, false);
    } else {
      void expandConnection(id);
    }
  }

  function connectOnDoubleClick() {
    if (status.state === 'disconnected' || status.state === 'error') {
      void connect(id);
    }
  }

  function openMenu(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    setMenuAt({ x: event.clientX, y: event.clientY });
  }

  return (
    <Stack gap={0}>
      <TreeRow
        depth={0}
        label={name}
        icon={<ConnectionStatusIcon status={status} />}
        trailing={color === undefined ? undefined : <ColorSwatch color={color} size={8} />}
        expandable
        expanded={expanded}
        selected={selected}
        onToggle={toggle}
        onSelect={() => select({ connectionId: id })}
        onDoubleClick={connectOnDoubleClick}
        onContextMenu={openMenu}
      />
      {expanded ? (
        <ConnectionChildren connectionId={id} status={status} databases={databases} />
      ) : null}
      {menuAt === undefined ? null : (
        <ConnectionContextMenu
          connection={connection}
          status={status}
          position={menuAt}
          onClose={() => setMenuAt(undefined)}
        />
      )}
    </Stack>
  );
}

interface ConnectionChildrenProps {
  readonly connectionId: string;
  readonly status: ConnectionStatus;
  readonly databases: Loadable<readonly DatabaseInfo[]> | undefined;
}

function ConnectionChildren({ connectionId, status, databases }: ConnectionChildrenProps) {
  if (status.state === 'connecting') {
    return <TreeMessage depth={1}>Connecting</TreeMessage>;
  }
  if (status.state === 'error') {
    return (
      <TreeMessage depth={1} tone="red">
        {status.error.message}
      </TreeMessage>
    );
  }
  if (status.state === 'disconnected') {
    return <TreeMessage depth={1}>Not connected. Double-click to connect.</TreeMessage>;
  }
  if (databases === undefined || databases.state === 'loading') {
    return <TreeMessage depth={1}>Loading databases</TreeMessage>;
  }
  if (databases.state === 'error') {
    return (
      <TreeMessage depth={1} tone="red">
        {databases.error.message}
      </TreeMessage>
    );
  }
  return (
    <Stack gap={0}>
      {databases.data.map((database: DatabaseInfo) => (
        <DatabaseNode
          key={database.name}
          connectionId={connectionId}
          database={database.name}
          depth={1}
        />
      ))}
    </Stack>
  );
}
