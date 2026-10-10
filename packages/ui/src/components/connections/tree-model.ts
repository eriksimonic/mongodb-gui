import type {
  CollectionInfo,
  ConnectionProfileSummary,
  ConnectionStatus,
  DatabaseInfo,
  DockerMongoContainerSummary,
  DockerStatus,
  GridFsBucket,
} from '@mongo-gui/core';
import type { Loadable } from '../../state/app-store';
import {
  DOCKER_NODE_ID,
  catalogKey,
  connectionNodeId,
  containerNodeId,
  databaseNodeId,
  gridfsBucketNodeId,
  gridfsNodeId,
  monitorNodeId,
  operationsNodeId,
  profilerNodeId,
} from '../../state/node-ids';
import { bucketLabel } from '../gridfs/gridfs-model';

export type TreeRowKind =
  | 'connection'
  | 'database'
  | 'collection'
  | 'profiler'
  | 'gridfs'
  | 'gridfs-bucket'
  | 'message'
  | 'docker'
  | 'container'
  | 'monitor'
  | 'operations';

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
  /** Set on `gridfs-bucket` rows only. */
  readonly bucket: string | undefined;
  readonly parentKey: string | undefined;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly color: string | undefined;
  readonly status: ConnectionStatus | undefined;
  /** Set on `container` rows only. */
  readonly container: DockerMongoContainerSummary | undefined;
  /** Tooltip text. Set when the row is shown without its container, for example with Docker down. */
  readonly note: string | undefined;
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
  /** GridFS buckets per database, keyed by `catalogKey`. Absent until the GridFS node loads them. */
  readonly gridfs?: Readonly<Record<string, Loadable<readonly GridFsBucket[]>>> | undefined;
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
    bucket: undefined,
    parentKey: undefined,
    expandable: false,
    expanded: false,
    color: undefined,
    status: undefined,
    container: undefined,
    note: undefined,
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
  const tools = toolRows(connectionId, parentKey, depth);
  const databases = input.databases[connectionId];
  if (databases === undefined || databases.state === 'loading') {
    return [...tools, messageRow(parentKey, connectionId, depth, 'Loading databases')];
  }
  if (databases.state === 'error') {
    return [...tools, messageRow(parentKey, connectionId, depth, databases.error.message, 'red')];
  }
  return [
    ...tools,
    ...databases.data.flatMap((database) =>
      databaseRows(input, connectionId, database.name, parentKey, depth),
    ),
  ];
}

/** The Monitoring and Operations children that sit above the databases of a connected connection. */
function toolRows(connectionId: string, parentKey: string, depth: number): TreeRow[] {
  return [
    makeRow({
      key: monitorNodeId(connectionId),
      kind: 'monitor',
      depth,
      label: 'Monitoring',
      connectionId,
      parentKey,
    }),
    makeRow({
      key: operationsNodeId(connectionId),
      kind: 'operations',
      depth,
      label: 'Operations',
      connectionId,
      parentKey,
    }),
  ];
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
  // The profiler node sits above the collections, so it is always visible under an open database.
  const profiler = makeRow({
    key: profilerNodeId(connectionId, database),
    kind: 'profiler',
    depth: childDepth,
    label: 'Profiler',
    connectionId,
    database,
    parentKey: key,
  });
  const gridfsKey = gridfsNodeId(connectionId, database);
  const gridfsExpanded = input.expanded[gridfsKey] === true;
  const gridfs = makeRow({
    key: gridfsKey,
    kind: 'gridfs',
    depth: childDepth,
    label: 'GridFS',
    connectionId,
    database,
    parentKey: key,
    expandable: true,
    expanded: gridfsExpanded,
  });
  const gridfsChildren = gridfsExpanded
    ? gridfsBucketRows(input, connectionId, database, gridfsKey, childDepth + 1)
    : [];
  return [
    row,
    profiler,
    gridfs,
    ...gridfsChildren,
    ...collectionRows(input, connectionId, database, key, childDepth),
  ];
}

/** The buckets under an open GridFS node, or the line that says why there are none. */
function gridfsBucketRows(
  input: TreeInput,
  connectionId: string,
  database: string,
  parentKey: string,
  depth: number,
): TreeRow[] {
  const buckets = input.gridfs?.[catalogKey(connectionId, database)];
  if (buckets === undefined || buckets.state === 'loading') {
    return [messageRow(parentKey, connectionId, depth, 'Loading buckets')];
  }
  if (buckets.state === 'error') {
    return [messageRow(parentKey, connectionId, depth, buckets.error.message, 'red')];
  }
  if (buckets.data.length === 0) {
    return [messageRow(parentKey, connectionId, depth, 'No buckets')];
  }
  return buckets.data.map((bucket) =>
    makeRow({
      key: gridfsBucketNodeId(connectionId, database, bucket.name),
      kind: 'gridfs-bucket',
      depth,
      label: bucketLabel(bucket),
      connectionId,
      database,
      bucket: bucket.name,
      parentKey,
    }),
  );
}

/** The collections of an open database, or the line that says why there are none. */
function collectionRows(
  input: TreeInput,
  connectionId: string,
  database: string,
  key: string,
  depth: number,
): TreeRow[] {
  const collections = input.collections[catalogKey(connectionId, database)];
  if (collections === undefined || collections.state === 'loading') {
    return [messageRow(key, connectionId, depth, 'Loading collections')];
  }
  if (collections.state === 'error') {
    return [messageRow(key, connectionId, depth, collections.error.message, 'red')];
  }
  if (collections.data.length === 0) {
    return [messageRow(key, connectionId, depth, 'No collections')];
  }
  return collections.data.map((collection) =>
    makeRow({
      key: `col:${catalogKey(connectionId, database)}/${collection.name}`,
      kind: 'collection',
      depth,
      label: collection.name,
      connectionId,
      database,
      collection: collection.name,
      collectionType: collection.type,
      parentKey: key,
    }),
  );
}

interface ConnectionRowExtras {
  /** The container behind a docker profile, when it is in the current list. */
  readonly container?: DockerMongoContainerSummary | undefined;
  readonly note?: string | undefined;
  /** The container is gone. The row says so and does not expand. */
  readonly missing?: boolean;
}

/** A connection row and, when it is open, the rows under it. Depth sets the indent. */
function connectionRows(
  input: TreeInput,
  connection: ConnectionProfileSummary,
  depth: number,
  parentKey: string | undefined,
  extras: ConnectionRowExtras = {},
): TreeRow[] {
  const key = connectionNodeId(connection.id);
  const status = input.statuses[connection.id] ?? DISCONNECTED;
  const expanded = input.expanded[key] === true && extras.missing !== true;
  const row = makeRow({
    key,
    kind: 'connection',
    depth,
    label: connection.name,
    connectionId: connection.id,
    parentKey,
    expandable: extras.missing !== true,
    expanded,
    color: connection.color,
    status,
    container: extras.container,
    note: extras.note,
  });
  if (extras.missing === true) {
    return [row, messageRow(key, connection.id, depth + CHILD, 'Container not found', 'red')];
  }
  if (!expanded) {
    return [row];
  }
  return [row, ...connectionChildren(input, connection.id, key, status, depth + CHILD)];
}

function dockerProfiles(input: TreeInput): ConnectionProfileSummary[] {
  return input.connections.filter((connection) => connection.source === 'docker');
}

function containerRows(
  input: TreeInput,
  container: DockerMongoContainerSummary,
  parentKey: string,
): TreeRow[] {
  const depth = CHILD;
  // A container with a connection keeps its container, so the row keeps its image, state and route.
  const profile = dockerProfiles(input).find((item) => item.dockerContainerId === container.id);
  if (profile !== undefined) {
    return connectionRows(input, profile, depth, parentKey, { container });
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
  const rows: TreeRow[] = [];
  const available = docker?.status?.available === true;
  const containers = docker?.containers;
  let listed: readonly DockerMongoContainerSummary[] | undefined;

  if (docker?.status === undefined) {
    rows.push(messageRow(parentKey, '', depth, 'Checking Docker'));
  } else if (!docker.status.available) {
    rows.push(messageRow(parentKey, '', depth, 'Docker not available'));
    rows.push(
      messageRow(parentKey, '', depth, docker.status.reason ?? 'The engine did not answer.'),
    );
  } else if (containers?.state === 'loading') {
    rows.push(messageRow(parentKey, '', depth, 'Looking for containers'));
  } else if (containers?.state === 'error') {
    rows.push(messageRow(parentKey, '', depth, containers.error.message, 'red'));
  } else if (containers?.state === 'ready') {
    listed = containers.data;
  }

  for (const container of listed ?? []) {
    rows.push(...containerRows(input, container, parentKey));
  }
  if (listed !== undefined && listed.length === 0 && dockerProfiles(input).length === 0) {
    rows.push(messageRow(parentKey, '', depth, 'No MongoDB containers found'));
  }

  // Profiles the list above did not show: containers that are gone, and all profiles while the
  // engine is unavailable or still loading. Each stays visible with the normal menu.
  const listedIds = new Set((listed ?? []).map((container) => container.id));
  for (const profile of dockerProfiles(input)) {
    if (listed !== undefined && listedIds.has(profile.dockerContainerId ?? '')) {
      continue;
    }
    const missing = listed !== undefined;
    rows.push(
      ...connectionRows(input, profile, depth, parentKey, {
        missing,
        note: !available && docker?.status !== undefined ? 'Docker not reachable' : undefined,
      }),
    );
  }
  return rows;
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
