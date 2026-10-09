/** Node id of a connection in the tree and in `AppData.expanded`. */
export function connectionNodeId(connectionId: string): string {
  return `conn:${connectionId}`;
}

/** Key of a database's collections in `AppData.collections`. Database names cannot contain `/`. */
export function catalogKey(connectionId: string, database: string): string {
  return `${connectionId}/${database}`;
}

/** Node id of the Docker node at the bottom of the tree. */
export const DOCKER_NODE_ID = 'docker';

/** Node id of a discovered container that has no connection yet. */
export function containerNodeId(containerId: string): string {
  return `dock:${containerId}`;
}

/** Node id of a database in the tree and in `AppData.expanded`. */
export function databaseNodeId(connectionId: string, database: string): string {
  return `db:${catalogKey(connectionId, database)}`;
}
