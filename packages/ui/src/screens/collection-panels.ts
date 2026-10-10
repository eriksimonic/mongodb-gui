import type { CollectionInfo, DatabaseInfo } from '@mongo-gui/core';
import type { Loadable, PanelRequest } from '../state/app-store';
import { catalogKey } from '../state/node-ids';

type DatabaseLists = Readonly<Record<string, Loadable<readonly DatabaseInfo[]>>>;
type CollectionLists = Readonly<Record<string, Loadable<readonly CollectionInfo[]>>>;

/**
 * True when a loaded list no longer has the database or collection a panel shows. A list that is
 * still loading or failed says nothing, so the panel stays until a list answers.
 */
export function isStalePanel(
  request: PanelRequest,
  databases: DatabaseLists,
  collections: CollectionLists,
): boolean {
  const databaseList = databases[request.connectionId];
  if (
    databaseList?.state === 'ready' &&
    !databaseList.data.some((item) => item.name === request.database)
  ) {
    return true;
  }
  const collectionList = collections[catalogKey(request.connectionId, request.database)];
  return (
    collectionList?.state === 'ready' &&
    !collectionList.data.some((item) => item.name === request.collection)
  );
}

const COLLECTION_PANEL_KINDS: readonly PanelRequest['panel'][] = [
  'indexes',
  'validation',
  'documents',
  'schema',
];

function isCollectionPanelKind(component: string): component is PanelRequest['panel'] {
  return (COLLECTION_PANEL_KINDS as readonly string[]).includes(component);
}

/**
 * The request a restored dock panel stands for. Undefined for panels that are not collection
 * panels, or whose params lack a connection, database or collection name.
 */
export function restoredCollectionRequest(
  component: string,
  params: unknown,
): PanelRequest | undefined {
  if (!isCollectionPanelKind(component) || typeof params !== 'object' || params === null) {
    return undefined;
  }
  const { connectionId, database, collection } = params as Record<string, unknown>;
  if (
    typeof connectionId !== 'string' ||
    typeof database !== 'string' ||
    typeof collection !== 'string'
  ) {
    return undefined;
  }
  return { panel: component, connectionId, database, collection };
}

/** The ids of the open collection panels that show a database or collection that is gone. */
export function stalePanelIds(
  open: ReadonlyMap<string, PanelRequest>,
  databases: DatabaseLists,
  collections: CollectionLists,
): string[] {
  return [...open]
    .filter(([, request]) => isStalePanel(request, databases, collections))
    .map(([id]) => id);
}

/** The ids of the open collection panels of one database. A drop closes them all. */
export function databasePanelIds(
  open: ReadonlyMap<string, PanelRequest>,
  connectionId: string,
  database: string,
): string[] {
  return [...open]
    .filter(([, request]) => request.connectionId === connectionId && request.database === database)
    .map(([id]) => id);
}
