import type {
  CollectionInfo,
  ConnectionProfileSummary,
  ConnectionStatus,
  DatabaseInfo,
  DockerMongoContainerSummary,
  DockerStatus,
} from '@mongo-gui/core';
import type { Loadable } from '../../state/app-store';
import {
  DOCKER_NODE_ID,
  catalogKey,
  connectionNodeId,
  containerNodeId,
  databaseNodeId,
} from '../../state/node-ids';

export type TreeRowKind =
  'connection' | 'database' | 'collection' | 'message' | 'docker' | 'container';

/** One visible line of the tree, flattened. Children follow their parent in the list. */
export interface TreeRow {
  readonly key: string;
  readonly kind: TreeRowKind;
  /** Zero for top-level nodes. Each level down adds one. */
  readonly depth: number;
  readonly label: string;
  /** Empty for the Docker node and for containers without a connection. */
  readonly connectionId: string;
  readonly database: string | undefined;
  readonly collection: string | undefined;
  readonly collectionType: CollectionInfo['type'] | undefined;
  readonly parentKey: string | undefined;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly color: string | undefined;
  readonly status: ConnectionStatus | undefined;
  /** Set on `container` rows only. */
  readonly container: DockerMongoContainerSummary | undefined;
  readonly tone: 'dimmed' | 'red';
}

export interface DockerTreeInput {
  readonly status: DockerStatus | undefined;
  readonly containers: Loadable<readonly DockerMongoContainerSummary[]>;
}

export interface TreeInput {
  readonly connections: readonly ConnectionProfileSummary[];
  readonly statuses: Readonly<Record<string, ConnectionStatus>>;
  readonly expanded: Readonly<Record<string, boolean>>;
  readonly databases: Readonly<Record<string, Loadable<readonly DatabaseInfo[]>>>;
  readonly collections: Readonly<Record<string, Loadable<readonly CollectionInfo[]>>>;
  /** Omitted before the Docker state is read. The node then shows a checking line. */
  readonly docker?: DockerTreeInput | undefined;
}

const DISCONNECTED: ConnectionStatus = { state: 'disconnected' };
const TOP_LEVEL = 0;
const CHILD = 1;

type RowInit = Pick<TreeRow, 'key' | 'kind' | 'depth' | 'label' | 'connectionId'> &
  Partial<TreeRow>;

function makeRow(init: RowInit): TreeRow {
  return {
    database: undefined,
    collection: undefined,
    collectionType: undefined,
    parentKey: undefined,
    expandable: false,
    expanded: false,
    color: undefined,
    status: undefined,
    container: undefined,
    tone: 'dimmed',
    ...init,
  };
}

function messageRow(
  parentKey: string,
  connectionId: string,
  depth: number,
  text: string,
  tone: TreeRow['tone'] = 'dimmed',
): TreeRow {
  return makeRow({
    key: `${parentKey}#message:${text}`,
    kind: 'message',
    depth,
    label: text,
    connectionId,
    parentKey,
    tone,
  });
}

function connectionChildren(
  input: TreeInput,
  connectionId: string,
  parentKey: string,
  status: ConnectionStatus,
  depth: number,
): TreeRow[] {
  if (status.state === 'connecting') {
    return [messageRow(parentKey, connectionId, depth, 'Connecting')];
  }
  if (status.state === 'error') {
    return [messageRow(parentKey, connectionId, depth, status.error.message, 'red')];
  }
  if (status.state === 'disconnected') {
    return [messageRow(parentKey, connectionId, depth, 'Not connected. Double-click to connect.')];
  }
  const databases = input.databases[connectionId];
  if (databases === undefined || databases.state === 'loading') {
    return [messageRow(parentKey, connectionId, depth, 'Loading databases')];
  }
  if (databases.state === 'error') {
    return [messageRow(parentKey, connectionId, depth, databases.error.message, 'red')];
  }
  return databases.data.flatMap((database) =>
    databaseRows(input, connectionId, database.name, parentKey, depth),
  );
}

function databaseRows(
  input: TreeInput,
  connectionId: string,
  database: string,
  parentKey: string,
  depth: number,
): TreeRow[] {
  const key = databaseNodeId(connectionId, database);
  const expanded = input.expanded[key] === true;
  const row = makeRow({
    key,
    kind: 'database',
    depth,
    label: database,
    connectionId,
    database,
    parentKey,
    expandable: true,
    expanded,
  });
  if (!expanded) {
    return [row];
  }
  const childDepth = depth + 1;
  const collections = input.collections[catalogKey(connectionId, database)];
  if (collections === undefined || collections.state === 'loading') {
    return [row, messageRow(key, connectionId, childDepth, 'Loading collections')];
  }
  if (collections.state === 'error') {
    return [row, messageRow(key, connectionId, childDepth, collections.error.message, 'red')];
  }
  if (collections.data.length === 0) {
    return [row, messageRow(key, connectionId, childDepth, 'No collections')];
  }
  return [
    row,
    ...collections.data.map((collection) =>
      makeRow({
        key: `col:${catalogKey(connectionId, database)}/${collection.name}`,
        kind: 'collection',
        depth: childDepth,
        label: collection.name,
        connectionId,
        database,
        collection: collection.name,
        collectionType: collection.type,
        parentKey: key,
      }),
    ),
  ];
}

/** A connection row and, when it is open, the rows under it. Depth sets the indent. */
function connectionRows(
  input: TreeInput,
  connection: ConnectionProfileSummary,
  depth: number,
  parentKey: string | undefined,
): TreeRow[] {
  const key = connectionNodeId(connection.id);
  const status = input.statuses[connection.id] ?? DISCONNECTED;
  const expanded = input.expanded[key] === true;
  const row = makeRow({
    key,
    kind: 'connection',
    depth,
    label: connection.name,
    connectionId: connection.id,
    parentKey,
    expandable: true,
    expanded,
    color: connection.color,
    status,
  });
  if (!expanded) {
    return [row];
  }
  return [row, ...connectionChildren(input, connection.id, key, status, depth + CHILD)];
}

function containerRows(
  input: TreeInput,
  container: DockerMongoContainerSummary,
  parentKey: string,
): TreeRow[] {
  const depth = CHILD;
  // A container with a connection shows the connection, so it expands like any other.
  const profile = input.connections.find((item) => item.dockerContainerId === container.id);
  if (profile !== undefined) {
    return connectionRows(input, profile, depth, parentKey);
  }
  return [
    makeRow({
      key: containerNodeId(container.id),
      kind: 'container',
      depth,
      label: container.name,
      connectionId: '',
      parentKey,
      container,
    }),
  ];
}

function dockerChildren(input: TreeInput, parentKey: string): TreeRow[] {
  const depth = CHILD;
  const docker = input.docker;
  if (docker?.status === undefined) {
    return [messageRow(parentKey, '', depth, 'Checking Docker')];
  }
  if (!docker.status.available) {
    return [
      messageRow(parentKey, '', depth, 'Docker not available'),
      messageRow(parentKey, '', depth, docker.status.reason ?? 'The engine did not answer.'),
    ];
  }
  const containers = docker.containers;
  if (containers.state === 'loading') {
    return [messageRow(parentKey, '', depth, 'Looking for containers')];
  }
  if (containers.state === 'error') {
    return [messageRow(parentKey, '', depth, containers.error.message, 'red')];
  }
  if (containers.data.length === 0) {
    return [messageRow(parentKey, '', depth, 'No MongoDB containers found')];
  }
  return containers.data.flatMap((container) => containerRows(input, container, parentKey));
}

function dockerRows(input: TreeInput): TreeRow[] {
  const key = DOCKER_NODE_ID;
  // The node starts open. Only an explicit collapse hides the containers.
  const expanded = input.expanded[key] !== false;
  const row = makeRow({
    key,
    kind: 'docker',
    depth: TOP_LEVEL,
    label: 'Docker',
    connectionId: '',
    expandable: true,
    expanded,
  });
  return expanded ? [row, ...dockerChildren(input, key)] : [row];
}

/**
 * Flattens the tree into the rows the screen shows, in order. Manual connections come first,
 * then the Docker node. Docker profiles appear under their container, not at the top.
 */
export function buildTreeRows(input: TreeInput): TreeRow[] {
  const manual = input.connections.filter((connection) => connection.source !== 'docker');
  return [
    ...manual.flatMap((connection) => connectionRows(input, connection, TOP_LEVEL, undefined)),
    ...dockerRows(input),
  ];
}

/** Rows a user can focus. Message lines are skipped by the keyboard. */
export function focusableRows(rows: readonly TreeRow[]): TreeRow[] {
  return rows.filter((row) => row.kind !== 'message');
}

export function nextFocusKey(
  rows: readonly TreeRow[],
  currentKey: string,
  step: 1 | -1,
): string | undefined {
  const focusable = focusableRows(rows);
  const index = focusable.findIndex((row) => row.key === currentKey);
  if (index === -1) {
    return focusable[0]?.key;
  }
  const next = Math.min(Math.max(index + step, 0), focusable.length - 1);
  return focusable[next]?.key;
}

export function edgeFocusKey(rows: readonly TreeRow[], edge: 'first' | 'last'): string | undefined {
  const focusable = focusableRows(rows);
  return edge === 'first' ? focusable[0]?.key : focusable[focusable.length - 1]?.key;
}

export function firstChildKey(rows: readonly TreeRow[], parentKey: string): string | undefined {
  return focusableRows(rows).find((row) => row.parentKey === parentKey)?.key;
}

export function parentKeyOf(rows: readonly TreeRow[], key: string): string | undefined {
  return rows.find((row) => row.key === key)?.parentKey;
}
