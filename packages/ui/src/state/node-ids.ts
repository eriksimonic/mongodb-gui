import type { ChangeTarget } from '@mongo-gui/core';
import { targetKeyOf } from '../changes/changes-model';

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

/** Node id of the Monitoring child under a connection. */
export function monitorNodeId(connectionId: string): string {
  return `mon:${connectionId}`;
}

/** Node id of the Operations child under a connection. */
export function operationsNodeId(connectionId: string): string {
  return `ops:${connectionId}`;
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

/** The dock id of a database's users and roles panel. */
export function usersPanelId(connectionId: string, database: string): string {
  return `users:${catalogKey(connectionId, database)}`;
}

/** Tree key of the GridFS node under a database. Its value in `AppData.expanded` is the open flag. */
export const GRIDFS_NODE_PREFIX = 'gfs:';

export function gridfsNodeId(connectionId: string, database: string): string {
  return `${GRIDFS_NODE_PREFIX}${catalogKey(connectionId, database)}`;
}

/** Tree key of one bucket under the GridFS node. */
export function gridfsBucketNodeId(connectionId: string, database: string, bucket: string): string {
  return `gfsb:${catalogKey(connectionId, database)}/${bucket}`;
}

/** Dockview panel id of a bucket's file panel. One panel per bucket. */
export function gridfsPanelId(connectionId: string, database: string, bucket: string): string {
  return `gridfs:${catalogKey(connectionId, database)}/${bucket}`;
}

/** Dockview panel id of a change stream panel. One panel per deployment, database or collection. */
export function changesPanelId(connectionId: string, target: ChangeTarget): string {
  return `changes:${connectionId}:${targetKeyOf(target)}`;
}
