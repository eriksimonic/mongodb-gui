/** Node id of a connection in the tree and in `AppData.expanded`. */
export function connectionNodeId(connectionId: string): string {
  return `conn:${connectionId}`;
}

/** Key of a database's collections in `AppData.collections`. Database names cannot contain `/`. */
export function catalogKey(connectionId: string, database: string): string {
  return `${connectionId}/${database}`;
}

/** Node id of a database in the tree and in `AppData.expanded`. */
export function databaseNodeId(connectionId: string, database: string): string {
  return `db:${catalogKey(connectionId, database)}`;
}

/** Tree key of the profiler node under a database. */
export function profilerNodeId(connectionId: string, database: string): string {
  return `prof:${catalogKey(connectionId, database)}`;
}

/** Dockview panel id of a database's profiler. One panel per database. */
export function profilerPanelId(connectionId: string, database: string): string {
  return `profiler:${catalogKey(connectionId, database)}`;
}
