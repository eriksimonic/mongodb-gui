import { z } from 'zod';
import type { ParsedUrl, ParsedUrlConstructor } from '../types/url';
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
import { AppVersionsSchema } from '../schemas/app';
import { LayoutGetOutputSchema, LayoutKeySchema, LayoutSetInputSchema } from '../schemas/layout';
import {
  MonitorConfigOutputSchema,
  MonitorKillInputSchema,
  MonitorOperationsInputSchema,
  MonitorOperationsOutputSchema,
  MonitorSamplesInputSchema,
  MonitorSamplesOutputSchema,
  MonitorSetIntervalInputSchema,
  MonitorStartInputSchema,
  MonitorStopInputSchema,
} from '../schemas/monitor';
import {
  FavouriteInputSchema,
  FavouriteSchema,
  HistoryAppendInputSchema,
  HistoryEntrySchema,
} from '../schemas/history';
import { VaultStatusSchema } from '../schemas/vault';
import {
  ShellCancelInputSchema,
  ShellCompleteInputSchema,
  ShellCompletionsSchema,
  ShellConnectionInputSchema,
  ShellEvaluateInputSchema,
  ShellEvaluationSchema,
  ShellNextInputSchema,
  ShellSampleSchemaInputSchema,
  ShellSchemaSampleSchema,
  ShellStateSchema,
} from '../shell/rpc-schemas';
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
import {
  DEFAULT_TAIL_POLL_MS,
  MAX_TAIL_POLL_MS,
  MIN_TAIL_POLL_MS,
  ProfileCollectionInfoSchema,
  ProfileEntrySchema,
  ProfileFilterSchema,
  ProfilingLevelSchema,
  QueryShapeSchema,
  SetProfilingLevelInputSchema,
} from '../profiler/types';
import {
  DockerContainerIdSchema,
  DockerMongoContainerSummarySchema,
  DockerStatusSchema,
} from '../docker/types';
import { UpdateStateSchema } from '../updates/types';
import { SchemaAnalyseInputSchema, SchemaReportSchema } from '../schema/types';
import {
  DialogResultSchema,
  OpenDialogInputSchema,
  PreviewImportInputSchema,
  SaveDialogInputSchema,
  ShowItemInFolderInputSchema,
  StartExportInputSchema,
  WriteExportInputSchema,
  StartImportInputSchema,
  StartTransferOutputSchema,
  TransferIdInputSchema,
  TransferListOutputSchema,
} from '../transfer/calls';
import { ImportPreviewSchema, TransferProgressSchema } from '../transfer/types';
import {
  ExplainResultSchema,
  ExplainRunCommandInputSchema,
  ExplainRunInputSchema,
} from '../explain/rpc-schemas';
import {
  ReplicationApplyInputSchema,
  ReplicationConfigOutputSchema,
  ReplicationConnectionInputSchema,
  ReplicationFreezeInputSchema,
  ReplicationInitiateInputSchema,
  ReplicationPlanInputSchema,
  ReplicationPlanOutputSchema,
  ReplicationStatusOutputSchema,
  ReplicationStepDownInputSchema,
  ReplicationStepDownOutputSchema,
} from '../replication/rpc-schemas';
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

/** The runtime URL class. Declared at module scope so no other package sees a changed global. */
declare const URL: ParsedUrlConstructor;

const PROJECT_PATH_PREFIX = '/eriksimonic/mongodb-gui/';
const MAX_LINK_LENGTH = 2048;
const ENCODED_DOT_OR_SLASH = /%2e|%2f/i;

/** Spaces, tabs, line breaks and other control characters. */
function hasWhitespaceOrControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || /\s/.test(char)) {
      return true;
    }
  }
  return false;
}

/**
 * True only for an https link to a page of the project on github.com. The check runs on the
 * parsed URL, so a traversal segment, a user name or a look-alike host cannot pass.
 */
export function isProjectLink(value: string): boolean {
  if (hasWhitespaceOrControl(value) || ENCODED_DOT_OR_SLASH.test(value)) {
    return false;
  }
  let url: ParsedUrl;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === 'github.com' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname.startsWith(PROJECT_PATH_PREFIX)
  );
}

const externalUrl = z
  .string()
  .max(MAX_LINK_LENGTH)
  .refine(isProjectLink, 'The link must point to a page of the project on GitHub.');

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
  shell: {
    evaluate: defineCall(ShellEvaluateInputSchema, ShellEvaluationSchema),
    next: defineCall(ShellNextInputSchema, ShellEvaluationSchema),
    cancel: defineCall(ShellCancelInputSchema, z.void()),
    complete: defineCall(ShellCompleteInputSchema, ShellCompletionsSchema),
    sampleSchema: defineCall(ShellSampleSchemaInputSchema, ShellSchemaSampleSchema),
    restart: defineCall(ShellConnectionInputSchema, z.void()),
    state: defineCall(ShellConnectionInputSchema, ShellStateSchema),
  },
  // Explain runs the statement's single collection query with explain on the connection's
  // runtime (run) or the connection's driver (runCommand). Nothing is written by explain.
  explain: {
    run: defineCall(ExplainRunInputSchema, ExplainResultSchema),
    runCommand: defineCall(ExplainRunCommandInputSchema, ExplainResultSchema),
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
  // Reads and changes a replica set through the connection. Only the node a connection points at
  // takes step-down and freeze. A plan lives in the main process until it is applied or expires.
  replication: {
    getStatus: defineCall(ReplicationConnectionInputSchema, ReplicationStatusOutputSchema),
    getConfig: defineCall(ReplicationConnectionInputSchema, ReplicationConfigOutputSchema),
    planReconfig: defineCall(ReplicationPlanInputSchema, ReplicationPlanOutputSchema),
    applyReconfig: defineCall(ReplicationApplyInputSchema, z.void()),
    stepDown: defineCall(ReplicationStepDownInputSchema, ReplicationStepDownOutputSchema),
    freeze: defineCall(ReplicationFreezeInputSchema, z.void()),
    initiate: defineCall(ReplicationInitiateInputSchema, z.void()),
  },
  // The sample is read by the shell runtime and the total from the server's metadata.
  schema: {
    analyse: defineCall(SchemaAnalyseInputSchema, SchemaReportSchema),
  },
  settings: {
    get: defineCall(z.void(), SettingsSchema),
    update: defineCall(SettingsPatchSchema, SettingsSchema),
  },
  monitor: {
    start: defineCall(MonitorStartInputSchema, MonitorConfigOutputSchema),
    stop: defineCall(MonitorStopInputSchema, z.void()),
    samples: defineCall(MonitorSamplesInputSchema, MonitorSamplesOutputSchema),
    operations: defineCall(MonitorOperationsInputSchema, MonitorOperationsOutputSchema),
    killOperation: defineCall(MonitorKillInputSchema, z.void()),
    setInterval: defineCall(MonitorSetIntervalInputSchema, MonitorConfigOutputSchema),
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
    append: defineCall(HistoryAppendInputSchema, HistoryEntrySchema),
    clear: defineCall(z.void(), z.void()),
  },
  favourites: {
    list: defineCall(z.void(), z.array(FavouriteSchema)),
    save: defineCall(FavouriteInputSchema, FavouriteSchema),
    remove: defineCall(idParam, z.void()),
  },
  profiler: {
    level: defineCall(databaseParam, ProfilingLevelSchema),
    setLevel: defineCall(
      databaseParam.extend(SetProfilingLevelInputSchema.omit({ filter: true }).shape),
      ProfilingLevelSchema,
    ),
    list: defineCall(
      databaseParam.extend({ filter: ProfileFilterSchema }),
      z.array(ProfileEntrySchema),
    ),
    shapes: defineCall(
      databaseParam.extend({ filter: ProfileFilterSchema }),
      z.array(QueryShapeSchema),
    ),
    info: defineCall(databaseParam, ProfileCollectionInfoSchema),
    tail: defineCall(
      databaseParam.extend({
        enabled: z.boolean(),
        pollMs: z
          .number()
          .int()
          .min(MIN_TAIL_POLL_MS)
          .max(MAX_TAIL_POLL_MS)
          .default(DEFAULT_TAIL_POLL_MS),
        filter: ProfileFilterSchema.optional(),
      }),
      z.void(),
    ),
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
  transfer: {
    previewImport: defineCall(PreviewImportInputSchema, ImportPreviewSchema),
    startImport: defineCall(StartImportInputSchema, StartTransferOutputSchema),
    startExport: defineCall(StartExportInputSchema, StartTransferOutputSchema),
    cancel: defineCall(TransferIdInputSchema, z.void()),
    status: defineCall(TransferIdInputSchema, TransferProgressSchema),
    list: defineCall(z.void(), TransferListOutputSchema),
  },
  updates: {
    state: defineCall(z.void(), UpdateStateSchema),
    check: defineCall(z.void(), UpdateStateSchema),
    download: defineCall(z.void(), UpdateStateSchema),
    install: defineCall(z.void(), z.void()),
    dismiss: defineCall(z.object({ version: z.string().min(1).max(64) }), UpdateStateSchema),
  },
  layout: {
    /** Returns the stored value, or null when nothing is saved under the key. */
    get: defineCall(z.object({ key: LayoutKeySchema }), LayoutGetOutputSchema),
    set: defineCall(LayoutSetInputSchema, z.void()),
  },
  app: {
    openExternal: defineCall(z.object({ url: externalUrl }), z.void()),
    versions: defineCall(z.void(), AppVersionsSchema),
    /** Shows the native open dialog. The renderer gets only the path the user picked. */
    showOpenDialog: defineCall(OpenDialogInputSchema, DialogResultSchema),
    showSaveDialog: defineCall(SaveDialogInputSchema, DialogResultSchema),
    /** Reveals a file this session exported. Other paths are refused by the router. */
    showItemInFolder: defineCall(ShowItemInFolderInputSchema, z.void()),
    /** Replaces the file the user picked with showSaveDialog with text. The pick is good for one write. */
    writeExport: defineCall(WriteExportInputSchema, z.void()),
  },
} satisfies RpcContract;
