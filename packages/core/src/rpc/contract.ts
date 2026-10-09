import { z } from 'zod';
import {
  ConnectionProfileInputSchema,
  ConnectionProfileSchema,
  ConnectionProfileSummarySchema,
  ConnectionStatusSchema,
  ConnectionTestResultSchema,
} from '../schemas/connection';
import {
  CollectionInfoSchema,
  CollectionStatsSchema,
  DatabaseInfoSchema,
  DatabaseStatsSchema,
  IndexInfoSchema,
} from '../schemas/catalog';
import { SettingsPatchSchema, SettingsSchema } from '../schemas/settings';
import { FavouriteInputSchema, FavouriteSchema, HistoryEntrySchema } from '../schemas/history';
import { VaultStatusSchema } from '../schemas/vault';
import {
  CheckValidationInputSchema,
  ClearCollectionInputSchema,
  CountDocumentsInputSchema,
  CreateCollectionInputSchema,
  CreateDatabaseInputSchema,
  CreateIndexInputSchema,
  DeleteByFilterInputSchema,
  DeleteDocumentsInputSchema,
  DropCollectionInputSchema,
  DropDatabaseInputSchema,
  DropIndexInputSchema,
  FindDocumentByIdInputSchema,
  IndexBuildProgressSchema,
  InsertDocumentInputSchema,
  ListIndexBuildsInputSchema,
  NamespaceSchema,
  RenameCollectionInputSchema,
  ReplaceDocumentInputSchema,
  SampleDocumentsInputSchema,
  SetIndexHiddenInputSchema,
  SetValidationInputSchema,
  UpdateDocumentFieldsInputSchema,
  ValidationCheckResultSchema,
  ValidationRulesSchema,
} from '../management/types';
import { defineCall, type RpcContract } from './define';

const idParam = z.object({ id: z.uuid() });
const connectionParam = z.object({ connectionId: z.uuid() });
const databaseParam = connectionParam.extend({ database: z.string().min(1) });
const collectionParam = databaseParam.extend({ collection: z.string().min(1) });
const password = z.string().min(1);
const newPassword = z.string().min(10);

/** Adds connectionId to a management input. The intersection keeps the input's refinements. */
function onConnection<T extends z.ZodType>(input: T) {
  return connectionParam.and(input);
}

export const rpcContract = {
  vault: {
    status: defineCall(z.void(), VaultStatusSchema),
    initialise: defineCall(z.object({ password: newPassword }), z.void()),
    unlock: defineCall(z.object({ password }), z.void()),
    lock: defineCall(z.void(), z.void()),
    changePassword: defineCall(z.object({ current: password, next: newPassword }), z.void()),
    reset: defineCall(z.object({ confirmation: z.literal('DELETE') }), z.void()),
  },
  connections: {
    list: defineCall(z.void(), z.array(ConnectionProfileSummarySchema)),
    get: defineCall(idParam, ConnectionProfileSchema),
    create: defineCall(ConnectionProfileInputSchema, ConnectionProfileSchema),
    update: defineCall(
      z.object({ id: z.uuid(), patch: ConnectionProfileInputSchema.partial() }),
      ConnectionProfileSchema,
    ),
    remove: defineCall(idParam, z.void()),
    test: defineCall(ConnectionProfileInputSchema, ConnectionTestResultSchema),
    connect: defineCall(idParam, ConnectionStatusSchema),
    disconnect: defineCall(idParam, z.void()),
    status: defineCall(idParam, ConnectionStatusSchema),
  },
  databases: {
    list: defineCall(connectionParam, z.array(DatabaseInfoSchema)),
    stats: defineCall(databaseParam, DatabaseStatsSchema),
  },
  collections: {
    list: defineCall(databaseParam, z.array(CollectionInfoSchema)),
    stats: defineCall(collectionParam, CollectionStatsSchema),
    indexes: defineCall(collectionParam, z.array(IndexInfoSchema)),
  },
  // Every input carries connectionId plus the adapter input. Mutating calls emit catalog:changed.
  management: {
    createCollection: defineCall(onConnection(CreateCollectionInputSchema), CollectionInfoSchema),
    renameCollection: defineCall(onConnection(RenameCollectionInputSchema), z.void()),
    dropCollection: defineCall(onConnection(DropCollectionInputSchema), z.void()),
    clearCollection: defineCall(onConnection(ClearCollectionInputSchema), z.void()),
    createDatabase: defineCall(onConnection(CreateDatabaseInputSchema), z.void()),
    dropDatabase: defineCall(onConnection(DropDatabaseInputSchema), z.void()),
    createIndex: defineCall(onConnection(CreateIndexInputSchema), IndexInfoSchema),
    dropIndex: defineCall(onConnection(DropIndexInputSchema), z.void()),
    setIndexHidden: defineCall(onConnection(SetIndexHiddenInputSchema), z.void()),
    listIndexBuilds: defineCall(
      connectionParam.and(ListIndexBuildsInputSchema),
      z.array(IndexBuildProgressSchema),
    ),
    getValidation: defineCall(onConnection(NamespaceSchema), ValidationRulesSchema),
    setValidation: defineCall(onConnection(SetValidationInputSchema), z.void()),
    checkValidation: defineCall(
      onConnection(CheckValidationInputSchema),
      ValidationCheckResultSchema,
    ),
    insertDocument: defineCall(onConnection(InsertDocumentInputSchema), z.string()),
    replaceDocument: defineCall(onConnection(ReplaceDocumentInputSchema), z.void()),
    updateDocumentFields: defineCall(onConnection(UpdateDocumentFieldsInputSchema), z.void()),
    deleteDocuments: defineCall(
      onConnection(DeleteDocumentsInputSchema),
      z.number().int().nonnegative(),
    ),
    deleteByFilter: defineCall(
      onConnection(DeleteByFilterInputSchema),
      z.number().int().nonnegative(),
    ),
    countDocuments: defineCall(
      onConnection(CountDocumentsInputSchema),
      z.number().int().nonnegative(),
    ),
    findDocumentById: defineCall(onConnection(FindDocumentByIdInputSchema), z.string().nullable()),
    sampleDocuments: defineCall(onConnection(SampleDocumentsInputSchema), z.array(z.string())),
  },
  settings: {
    get: defineCall(z.void(), SettingsSchema),
    update: defineCall(SettingsPatchSchema, SettingsSchema),
  },
  history: {
    list: defineCall(
      z.object({
        connectionId: z.uuid().optional(),
        search: z.string().optional(),
        limit: z.number().int().positive().optional(),
      }),
      z.array(HistoryEntrySchema),
    ),
    clear: defineCall(z.void(), z.void()),
  },
  favourites: {
    list: defineCall(z.void(), z.array(FavouriteSchema)),
    save: defineCall(FavouriteInputSchema, FavouriteSchema),
    remove: defineCall(idParam, z.void()),
  },
} satisfies RpcContract;
