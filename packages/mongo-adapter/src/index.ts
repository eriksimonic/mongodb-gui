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
export { killOperation, listOperations, type ListOperationsOptions } from './monitor/operations';
export {
  Sampler,
  type SampleErrorListener,
  type SampleListener,
  type SamplerOptions,
} from './monitor/sampler';
