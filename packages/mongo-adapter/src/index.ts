export const mongoAdapterPackageName = '@mongo-gui/mongo-adapter';

export { buildClientOptions } from './client-options';
export { ConnectionManager, type StatusListener } from './connection-manager';
export {
  collectionStats,
  databaseStats,
  listCollections,
  listDatabases,
  listIndexes,
  type ListCollectionsOptions,
} from './catalog';
export { mapDriverError } from './errors';
export {
  getProfilingLevel,
  listProfileEntries,
  profileCollectionInfo,
  setProfilingLevel,
  tailProfileEntries,
  type ProfileCollectionInfo,
  type ProfileTail,
} from './profiler/profiler';
