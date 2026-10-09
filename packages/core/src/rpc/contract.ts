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
  DockerContainerIdSchema,
  DockerMongoContainerSummarySchema,
  DockerStatusSchema,
} from '../docker/types';
import { defineCall, type RpcContract } from './define';

const idParam = z.object({ id: z.uuid() });
const connectionParam = z.object({ connectionId: z.uuid() });
const databaseParam = connectionParam.extend({ database: z.string().min(1) });
const collectionParam = databaseParam.extend({ collection: z.string().min(1) });
const password = z.string().min(1);
const newPassword = z.string().min(10);

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
  docker: {
    status: defineCall(z.void(), DockerStatusSchema),
    list: defineCall(z.void(), z.array(DockerMongoContainerSummarySchema)),
    connect: defineCall(
      z.object({ containerId: DockerContainerIdSchema }),
      z.object({ connectionId: z.uuid(), status: ConnectionStatusSchema }),
    ),
    disconnect: defineCall(z.object({ containerId: DockerContainerIdSchema }), z.void()),
    setAutoConnect: defineCall(z.object({ enabled: z.boolean() }), SettingsSchema),
    /** Starts or stops the 10 second poll that pushes `docker:containers` events. */
    watch: defineCall(z.object({ enabled: z.boolean() }), z.void()),
  },
} satisfies RpcContract;
