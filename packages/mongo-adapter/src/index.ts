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
export { toCanonicalEjson } from './ejson';
export { mapDriverError } from './errors';
export { exportCollection } from './transfer/export';
export { importFile, previewImport } from './transfer/import';
export { readServerInfo, type ServerInfo } from './server-info';
export * from './diagnostics/index';
export * from './management/index';
export { killOperation, listOperations, type ListOperationsOptions } from './monitor/operations';
export {
  Sampler,
  type SampleErrorListener,
  type SampleListener,
  type SamplerOptions,
} from './monitor/sampler';
export {
  getProfilingLevel,
  listProfileEntries,
  profileCollectionInfo,
  setProfilingLevel,
  tailProfileEntries,
  type ProfileCollectionInfo,
  type ProfileTail,
} from './profiler/profiler';
