import {
  backupFileName,
  defaultBackupName,
  dumpOptionProblems,
  sidecarPathFor,
  BackupNameSchema,
  type BackupScope,
  type BackupServerInfo,
  type BackupStartInput,
  type ConnectionStatus,
  type DumpOptions,
  type FindingCode,
  type SavedBackup,
  type SavedBackupInput,
  type ReadPreferenceMode,
  type WireCompressor,
} from '@mongo-gui/core';
import { checkEjsonObject } from '../transfers';

export interface BackupDraft {
  /** `connection` picks databases (none means the whole server), `collection` picks one collection. */
  readonly target: 'connection' | 'collection';
  /** Databases to back up. Several are only valid for the connection target. */
  readonly databases: readonly string[];
  readonly collection: string;
  readonly excludeCollections: readonly string[];
  readonly excludePrefixes: readonly string[];
  /** Extended JSON, collection target only. Empty means no query. */
  readonly query: string;
  readonly folder: string;
  readonly name: string;
  readonly output: 'archive' | 'directory';
  readonly gzip: boolean;
  /** Undefined keeps the connection's own. */
  readonly readPreference: ReadPreferenceMode | undefined;
  readonly oplog: boolean;
  readonly dumpDbUsersAndRoles: boolean;
  readonly viewsAsCollections: boolean;
  readonly forceTableScan: boolean;
  readonly numParallelCollections: number;
  readonly compressors: readonly WireCompressor[];
  readonly toolsVersion: string;
}

export const DEFAULT_BACKUP_DRAFT: BackupDraft = {
  target: 'connection',
  databases: [],
  collection: '',
  excludeCollections: [],
  excludePrefixes: [],
  query: '',
  folder: '',
  name: '',
  output: 'archive',
  gzip: true,
  readPreference: undefined,
  oplog: false,
  dumpDbUsersAndRoles: false,
  viewsAsCollections: false,
  forceTableScan: false,
  numParallelCollections: 4,
  compressors: [],
  toolsVersion: '',
};

export interface BackupProblem {
  readonly field: string;
  readonly message: string;
}

/**
 * The scope the draft describes, or undefined while a collection target lacks its database or
 * collection. One database gives `database`, several give `databases`, none gives `server`.
 */
export function scopeOf(draft: BackupDraft): BackupScope | undefined {
  if (draft.target === 'collection') {
    const [database] = draft.databases;
    if (database === undefined || draft.collection === '') {
      return undefined;
    }
    return { kind: 'collection', database, collection: draft.collection };
  }
  if (draft.databases.length === 0) {
    return { kind: 'server' };
  }
  if (draft.databases.length === 1) {
    return { kind: 'database', database: draft.databases[0] as string };
  }
  return { kind: 'databases', databases: [...draft.databases] };
}

/** A draft for the entry point that opened the dialog, with the default name filled in. */
export function draftForTarget(input: {
  connectionName: string;
  database?: string | undefined;
  collection?: string | undefined;
  now: Date;
}): BackupDraft {
  const base: BackupDraft =
    input.database !== undefined && input.collection !== undefined
      ? {
          ...DEFAULT_BACKUP_DRAFT,
          target: 'collection',
          databases: [input.database],
          collection: input.collection,
        }
      : input.database !== undefined
        ? { ...DEFAULT_BACKUP_DRAFT, databases: [input.database] }
        : DEFAULT_BACKUP_DRAFT;
  const scope = scopeOf(base) ?? { kind: 'server' };
  return { ...base, name: defaultBackupName(input.connectionName, scope, input.now) };
}

/** The profile's read preference, else primaryPreferred on a direct connection, else primary. */
export function defaultReadPreference(
  status: ConnectionStatus | undefined,
  profileReadPreference: ReadPreferenceMode | undefined,
): ReadPreferenceMode {
  if (profileReadPreference !== undefined) {
    return profileReadPreference;
  }
  if (status?.state === 'connected' && status.directConnection === true) {
    return 'primaryPreferred';
  }
  return 'primary';
}

function dumpOptionsOf(draft: BackupDraft): DumpOptions {
  const query = draft.query.trim();
  return {
    output: draft.output,
    gzip: draft.gzip,
    ...(draft.readPreference === undefined ? {} : { readPreference: draft.readPreference }),
    ...(query === '' ? {} : { query }),
    excludeCollections: [...draft.excludeCollections],
    excludeCollectionsWithPrefix: [...draft.excludePrefixes],
    oplog: draft.oplog,
    dumpDbUsersAndRoles: draft.dumpDbUsersAndRoles,
    viewsAsCollections: draft.viewsAsCollections,
    forceTableScan: draft.forceTableScan,
    numParallelCollections: draft.numParallelCollections,
    compressors: [...draft.compressors],
  };
}

/** The draft's scope and options as a saved configuration. Folder and file name are not kept. */
export function savedBackupInput(
  draft: BackupDraft,
  connectionId: string,
  label: string,
): SavedBackupInput {
  return {
    label: label.trim(),
    connectionId,
    scope: scopeOf(draft) ?? { kind: 'server' },
    options: dumpOptionsOf(draft),
    ...(draft.toolsVersion === '' ? {} : { toolsVersion: draft.toolsVersion }),
  };
}

/** The draft with a saved configuration applied. The folder and file name stay as they are. */
export function draftFromSaved(draft: BackupDraft, saved: SavedBackup): BackupDraft {
  const { scope, options } = saved;
  return {
    ...draft,
    target: scope.kind === 'collection' ? 'collection' : 'connection',
    databases:
      scope.kind === 'server'
        ? []
        : scope.kind === 'databases'
          ? scope.databases
          : [scope.database],
    collection: scope.kind === 'collection' ? scope.collection : '',
    excludeCollections: options.excludeCollections,
    excludePrefixes: options.excludeCollectionsWithPrefix,
    query: options.query ?? '',
    output: options.output,
    gzip: options.gzip,
    readPreference: options.readPreference,
    oplog: options.oplog,
    dumpDbUsersAndRoles: options.dumpDbUsersAndRoles,
    viewsAsCollections: options.viewsAsCollections,
    forceTableScan: options.forceTableScan,
    numParallelCollections: options.numParallelCollections,
    compressors: options.compressors,
    toolsVersion: saved.toolsVersion ?? draft.toolsVersion,
  };
}

/** Every problem with the draft, in the order the form shows the fields. */
export function backupProblemsOf(
  draft: BackupDraft,
  server?: Pick<BackupServerInfo, 'topology'>,
): BackupProblem[] {
  const problems: BackupProblem[] = [];
  const scope = scopeOf(draft);
  if (scope === undefined) {
    problems.push({
      field: 'scope',
      message:
        draft.databases.length === 0
          ? 'Choose the database of the collection'
          : 'Choose the collection to back up',
    });
  } else if (draft.target === 'collection' && draft.databases.length > 1) {
    problems.push({ field: 'scope', message: 'A collection backup needs one database' });
  }
  if (draft.folder.trim() === '') {
    problems.push({ field: 'folder', message: 'Choose where to save the backup' });
  }
  if (draft.name.trim() === '') {
    problems.push({ field: 'name', message: 'Enter a name for the backup' });
  } else if (!BackupNameSchema.safeParse(draft.name).success) {
    problems.push({
      field: 'name',
      message: 'The name cannot hold \\ / : * ? " < > | or end with a dot or space',
    });
  }
  const query = checkEjsonObject('The query', draft.query);
  const queryFailed = !query.ok;
  if (!query.ok) {
    problems.push({ field: 'query', message: query.message });
  }
  if (draft.numParallelCollections < 1 || draft.numParallelCollections > 16) {
    problems.push({
      field: 'numParallelCollections',
      message: 'Parallel collections is a number from 1 to 16',
    });
  }
  // Core checks the rest. Its query check repeats ours, so it is skipped after a failure.
  const optionScope = scope ?? { kind: 'server' as const };
  for (const problem of dumpOptionProblems(optionScope, dumpOptionsOf(draft), server)) {
    if (queryFailed && problem.field === 'query') {
      continue;
    }
    // A collection target without a scope yet would report the query as misplaced.
    if (scope === undefined && problem.field === 'query') {
      continue;
    }
    problems.push(problem);
  }
  return problems;
}

/** The request for `backup.start`. Call it only when `backupProblemsOf` returns nothing. */
export function backupStartInput(
  draft: BackupDraft,
  connectionId: string,
  acknowledged: readonly FindingCode[] = [],
): BackupStartInput {
  return {
    connectionId,
    scope: scopeOf(draft) ?? { kind: 'server' },
    options: dumpOptionsOf(draft),
    folder: draft.folder.trim(),
    name: draft.name.trim(),
    toolsVersion: draft.toolsVersion,
    acknowledged: [...acknowledged],
  };
}

/** Where the backup and its sidecar will be written, or undefined until a folder is chosen. */
export function outputPreview(
  draft: Pick<BackupDraft, 'folder' | 'name' | 'output' | 'gzip'>,
): { outputPath: string; sidecarPath: string } | undefined {
  const folder = draft.folder.trim();
  if (folder === '' || draft.name.trim() === '') {
    return undefined;
  }
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  const base = folder.endsWith(sep) ? folder.slice(0, -1) : folder;
  const outputPath = `${base}${sep}${backupFileName(draft.name.trim(), draft)}`;
  return { outputPath, sidecarPath: sidecarPathFor(outputPath, draft.output) };
}
