import { rpcContract, type RpcEvent } from '@mongo-gui/core';
import {
  checkDocumentsAgainstValidator,
  clearCollection,
  collectionStats,
  countDocuments,
  createCollection,
  createDatabase,
  createIndex,
  databaseStats,
  deleteByFilter,
  deleteDocuments,
  dropCollection,
  dropDatabase,
  dropIndex,
  findDocumentById,
  getValidation,
  insertDocument,
  listCollections,
  listDatabases,
  listIndexBuilds,
  listIndexes,
  renameCollection,
  replaceDocument,
  sampleDocuments,
  setIndexHidden,
  setValidation,
  updateDocumentFields,
} from '@mongo-gui/mongo-adapter';
import { connectionCalls, driverCall, entry, type Operation } from './operation';

/** The client a database, collection and document call runs against. */
type ManagementClient = Parameters<typeof listDatabases>[0];

/** What the database, collection and document calls need from the router. */
export interface ManagementDeps {
  readonly getClient: (connectionId: string) => ManagementClient;
  readonly emit: (event: RpcEvent) => void;
}

/**
 * Database, collection, index, validation and document calls. The changes report a catalog change
 * for the database or collection they touched. The reads report none.
 */
export function managementOperations(deps: ManagementDeps): [string, Operation][] {
  const { managed, readOnly } = connectionCalls(deps.getClient, deps.emit);
  const m = rpcContract.management;
  return [
    managed(
      'management.createCollection',
      m.createCollection,
      (client, input) => createCollection(client, input),
      (input) => ({ database: input.database, collection: input.name }),
    ),
    managed(
      'management.renameCollection',
      m.renameCollection,
      (client, input) => renameCollection(client, input),
      (input) => ({ database: input.database, collection: input.name }),
    ),
    managed(
      'management.dropCollection',
      m.dropCollection,
      (client, input) => dropCollection(client, input),
      (input) => ({ database: input.database, collection: input.name }),
    ),
    managed(
      'management.clearCollection',
      m.clearCollection,
      (client, input) => clearCollection(client, input),
      (input) => ({ database: input.database, collection: input.name }),
    ),
    managed(
      'management.createDatabase',
      m.createDatabase,
      (client, input) => createDatabase(client, input),
      (input) => ({ database: input.database }),
    ),
    managed(
      'management.dropDatabase',
      m.dropDatabase,
      (client, input) => dropDatabase(client, input),
      (input) => ({ database: input.database }),
    ),
    managed(
      'management.createIndex',
      m.createIndex,
      (client, input) => createIndex(client, input),
      (input) => ({ database: input.database, collection: input.collection }),
    ),
    managed(
      'management.dropIndex',
      m.dropIndex,
      (client, input) => dropIndex(client, input),
      (input) => ({ database: input.database, collection: input.collection }),
    ),
    managed(
      'management.setIndexHidden',
      m.setIndexHidden,
      (client, input) => setIndexHidden(client, input),
      (input) => ({ database: input.database, collection: input.collection }),
    ),
    readOnly('management.listIndexBuilds', m.listIndexBuilds, (client, input) =>
      listIndexBuilds(client, input.database),
    ),
    readOnly('management.getValidation', m.getValidation, (client, input) =>
      getValidation(client, input.database, input.collection),
    ),
    managed(
      'management.setValidation',
      m.setValidation,
      (client, input) => setValidation(client, input),
      (input) => ({ database: input.database, collection: input.collection }),
    ),
    readOnly('management.checkValidation', m.checkValidation, (client, input) =>
      checkDocumentsAgainstValidator(
        client,
        input.database,
        input.collection,
        input.sampleSize,
        input.validatorEjson,
      ),
    ),
    managed(
      'management.insertDocument',
      m.insertDocument,
      (client, input) => insertDocument(client, input),
      (input) => ({ database: input.database, collection: input.collection }),
    ),
    managed(
      'management.replaceDocument',
      m.replaceDocument,
      (client, input) => replaceDocument(client, input),
      (input) => ({ database: input.database, collection: input.collection }),
    ),
    managed(
      'management.updateDocumentFields',
      m.updateDocumentFields,
      (client, input) => updateDocumentFields(client, input),
      (input) => ({ database: input.database, collection: input.collection }),
    ),
    managed(
      'management.deleteDocuments',
      m.deleteDocuments,
      (client, input) => deleteDocuments(client, input),
      (input) => ({ database: input.database, collection: input.collection }),
    ),
    managed(
      'management.deleteByFilter',
      m.deleteByFilter,
      (client, input) => deleteByFilter(client, input),
      (input) => ({ database: input.database, collection: input.collection }),
    ),
    readOnly('management.countDocuments', m.countDocuments, (client, input) =>
      countDocuments(client, input),
    ),
    readOnly('management.findDocumentById', m.findDocumentById, (client, input) =>
      findDocumentById(client, input),
    ),
    readOnly('management.sampleDocuments', m.sampleDocuments, (client, input) =>
      sampleDocuments(client, input),
    ),

    entry('databases.list', rpcContract.databases.list, (input) =>
      driverCall(() => listDatabases(deps.getClient(input.connectionId))),
    ),
    entry('databases.stats', rpcContract.databases.stats, (input) =>
      driverCall(() => databaseStats(deps.getClient(input.connectionId), input.database)),
    ),

    entry('collections.list', rpcContract.collections.list, (input) =>
      driverCall(() => listCollections(deps.getClient(input.connectionId), input.database)),
    ),
    entry('collections.stats', rpcContract.collections.stats, (input) =>
      driverCall(() =>
        collectionStats(deps.getClient(input.connectionId), input.database, input.collection),
      ),
    ),
    entry('collections.indexes', rpcContract.collections.indexes, (input) =>
      driverCall(() =>
        listIndexes(deps.getClient(input.connectionId), input.database, input.collection),
      ),
    ),
  ];
}
