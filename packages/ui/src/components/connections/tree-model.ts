import type {
  CollectionInfo,
  ConnectionProfileSummary,
  ConnectionStatus,
  DatabaseInfo,
} from '@mongo-gui/core';
import type { Loadable } from '../../state/app-store';
import { catalogKey, connectionNodeId, databaseNodeId, profilerNodeId } from '../../state/node-ids';

export type TreeRowKind = 'connection' | 'database' | 'collection' | 'profiler' | 'message';

/** One visible line of the tree, flattened. Children follow their parent in the list. */
export interface TreeRow {
  readonly key: string;
  readonly kind: TreeRowKind;
  /** Zero for connections. Each level down adds one. */
  readonly depth: number;
  readonly label: string;
  readonly connectionId: string;
  readonly database: string | undefined;
  readonly collection: string | undefined;
  readonly collectionType: CollectionInfo['type'] | undefined;
  readonly parentKey: string | undefined;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly color: string | undefined;
  readonly status: ConnectionStatus | undefined;
  readonly tone: 'dimmed' | 'red';
}

export interface TreeInput {
  readonly connections: readonly ConnectionProfileSummary[];
  readonly statuses: Readonly<Record<string, ConnectionStatus>>;
  readonly expanded: Readonly<Record<string, boolean>>;
  readonly databases: Readonly<Record<string, Loadable<readonly DatabaseInfo[]>>>;
  readonly collections: Readonly<Record<string, Loadable<readonly CollectionInfo[]>>>;
}

const DISCONNECTED: ConnectionStatus = { state: 'disconnected' };

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
    key: `${parentKey}#message`,
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
): TreeRow[] {
  const depth = 1;
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
    databaseRows(input, connectionId, database.name, parentKey),
  );
}

function databaseRows(
  input: TreeInput,
  connectionId: string,
  database: string,
  parentKey: string,
): TreeRow[] {
  const key = databaseNodeId(connectionId, database);
  const expanded = input.expanded[key] === true;
  const row = makeRow({
    key,
    kind: 'database',
    depth: 1,
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
  const depth = 2;
  const profiler = makeRow({
    key: profilerNodeId(connectionId, database),
    kind: 'profiler',
    depth,
    label: 'Profiler',
    connectionId,
    database,
    parentKey: key,
  });
  return [row, profiler, ...collectionRows(input, connectionId, database, key)];
}

/** The collections of an open database, or the line that says why there are none. */
function collectionRows(
  input: TreeInput,
  connectionId: string,
  database: string,
  key: string,
): TreeRow[] {
  const depth = 2;
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

/** Flattens the connection tree into the rows the screen shows, in order. */
export function buildTreeRows(input: TreeInput): TreeRow[] {
  return input.connections.flatMap((connection) => {
    const key = connectionNodeId(connection.id);
    const status = input.statuses[connection.id] ?? DISCONNECTED;
    const expanded = input.expanded[key] === true;
    const row = makeRow({
      key,
      kind: 'connection',
      depth: 0,
      label: connection.name,
      connectionId: connection.id,
      expandable: true,
      expanded,
      color: connection.color,
      status,
    });
    return expanded ? [row, ...connectionChildren(input, connection.id, key, status)] : [row];
  });
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
