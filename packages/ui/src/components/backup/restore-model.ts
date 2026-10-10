import {
  normaliseRestoreOptions,
  restoreOptionProblems,
  type BackupInspection,
  type DatabaseRename,
  type RestoreOptions,
  type RestoreStartInput,
  type FindingCode,
} from '@mongo-gui/core';
import type { BackupProblem } from './backup-model';

export interface ContentsNamespace {
  readonly database: string;
  readonly collection: string;
}

export type CheckState = 'all' | 'some' | 'none';

type DraftOptions = Omit<RestoreOptions, 'include' | 'renames' | 'oplogLimit'>;

export interface RestoreDraft extends DraftOptions {
  /** Every namespace in the backup, in the order the tree shows them. */
  readonly contents: readonly ContentsNamespace[];
  /** Namespaces the user unchecked, as `database.collection`. */
  readonly unchecked: readonly string[];
  /** Target name per source database, only where the user typed one. */
  readonly renameTo: Readonly<Record<string, string>>;
  /** Empty means no limit. */
  readonly oplogLimit: string;
  readonly toolsVersion: string;
}

export interface RenameRow {
  readonly from: string;
  readonly to: string;
  /** True when the target database already exists on the connection. */
  readonly exists: boolean;
}

const keyOf = (database: string, collection: string) => `${database}.${collection}`;

export interface DraftFromInspectionInput {
  /** Set when the dialog was opened from a database menu. */
  readonly targetDatabase?: string | undefined;
  readonly installedVersions: readonly string[];
  /** The tools version the preference resolves to now, if any. */
  readonly preference?: string | undefined;
}

/**
 * The tools a restore starts with: the version that made the backup when it is installed, else
 * the preference, else ''.
 */
export function defaultRestoreTools(
  inspection: Pick<BackupInspection, 'sidecar' | 'prelude'>,
  installedVersions: readonly string[],
  preference: string | undefined,
): string {
  const dumpTools = inspection.sidecar?.tools.version ?? inspection.prelude?.toolsVersion;
  return dumpTools !== undefined && installedVersions.includes(dumpTools)
    ? dumpTools
    : (preference ?? '');
}

export function draftFromInspection(
  inspection: Pick<BackupInspection, 'namespaces' | 'sidecar' | 'prelude'>,
  input: DraftFromInspectionInput,
): RestoreDraft {
  const contents = inspection.namespaces.map(({ database, collection }) => ({
    database,
    collection,
  }));
  const databases = [...new Set(contents.map((namespace) => namespace.database))];
  const toolsVersion = defaultRestoreTools(inspection, input.installedVersions, input.preference);
  const [only] = databases;
  const renameTo =
    input.targetDatabase !== undefined && databases.length === 1 && only !== undefined
      ? { [only]: input.targetDatabase }
      : {};
  return {
    contents,
    unchecked: [],
    renameTo,
    oplogLimit: '',
    toolsVersion,
    drop: false,
    dryRun: false,
    oplogReplay: false,
    restoreDbUsersAndRoles: false,
    preserveUUID: false,
    noIndexRestore: false,
    noOptionsRestore: false,
    convertLegacyIndexes: false,
    maintainInsertionOrder: false,
    stopOnError: false,
    bypassDocumentValidation: false,
    objcheck: false,
    writeConcern: 'majority',
    numParallelCollections: 4,
    numInsertionWorkersPerCollection: 1,
    verifyChecksum: true,
  };
}

/** The databases in the backup, in tree order. */
export function databasesOf(draft: Pick<RestoreDraft, 'contents'>): string[] {
  return [...new Set(draft.contents.map((namespace) => namespace.database))];
}

export function collectionsOf(draft: Pick<RestoreDraft, 'contents'>, database: string): string[] {
  return draft.contents
    .filter((namespace) => namespace.database === database)
    .map((namespace) => namespace.collection);
}

export function isCollectionChecked(
  draft: Pick<RestoreDraft, 'unchecked'>,
  database: string,
  collection: string,
): boolean {
  return !draft.unchecked.includes(keyOf(database, collection));
}

export function databaseCheckState(
  draft: Pick<RestoreDraft, 'contents' | 'unchecked'>,
  database: string,
): CheckState {
  const collections = collectionsOf(draft, database);
  const checked = collections.filter((collection) =>
    isCollectionChecked(draft, database, collection),
  ).length;
  if (checked === 0) {
    return 'none';
  }
  return checked === collections.length ? 'all' : 'some';
}

export function toggleCollection(
  draft: RestoreDraft,
  database: string,
  collection: string,
  checked: boolean,
): RestoreDraft {
  const key = keyOf(database, collection);
  const rest = draft.unchecked.filter((entry) => entry !== key);
  return { ...draft, unchecked: checked ? rest : [...rest, key] };
}

/** Checks or unchecks every collection of a database. */
export function toggleDatabase(
  draft: RestoreDraft,
  database: string,
  checked: boolean,
): RestoreDraft {
  const keys = new Set(collectionsOf(draft, database).map((name) => keyOf(database, name)));
  const rest = draft.unchecked.filter((entry) => !keys.has(entry));
  return { ...draft, unchecked: checked ? rest : [...rest, ...keys] };
}

/**
 * The `include` selectors. Undefined when everything is checked, `db.*` for a fully checked
 * database and `db.coll` for each checked collection of a partly checked one.
 */
export function includeFrom(
  draft: Pick<RestoreDraft, 'contents' | 'unchecked'>,
): string[] | undefined {
  if (draft.unchecked.length === 0) {
    return undefined;
  }
  const include: string[] = [];
  for (const database of databasesOf(draft)) {
    const state = databaseCheckState(draft, database);
    if (state === 'all') {
      include.push(`${database}.*`);
    } else if (state === 'some') {
      for (const collection of collectionsOf(draft, database)) {
        if (isCollectionChecked(draft, database, collection)) {
          include.push(keyOf(database, collection));
        }
      }
    }
  }
  return include;
}

/** One row per database with something checked. `existing` lists the target's databases. */
export function renameRows(
  draft: Pick<RestoreDraft, 'contents' | 'unchecked' | 'renameTo'>,
  existing: readonly string[] = [],
): RenameRow[] {
  return databasesOf(draft)
    .filter((database) => databaseCheckState(draft, database) !== 'none')
    .map((from) => {
      const to = draft.renameTo[from] ?? from;
      return { from, to, exists: existing.includes(to) };
    });
}

export function setRename(draft: RestoreDraft, from: string, to: string): RestoreDraft {
  return { ...draft, renameTo: { ...draft.renameTo, [from]: to } };
}

/** The renames that change a name. A blank target is kept so the option check reports it. */
export function renamesOf(draft: RestoreDraft): DatabaseRename[] {
  return renameRows(draft)
    .map((row) => ({ from: row.from, to: row.to.trim() }))
    .filter((rename) => rename.from !== rename.to);
}

function restoreOptionsOf(draft: RestoreDraft): RestoreOptions {
  const include = includeFrom(draft);
  const oplogLimit = draft.oplogLimit.trim();
  return normaliseRestoreOptions({
    ...(include === undefined ? {} : { include }),
    renames: renamesOf(draft),
    drop: draft.drop,
    dryRun: draft.dryRun,
    oplogReplay: draft.oplogReplay,
    ...(oplogLimit === '' ? {} : { oplogLimit }),
    restoreDbUsersAndRoles: draft.restoreDbUsersAndRoles,
    preserveUUID: draft.preserveUUID,
    noIndexRestore: draft.noIndexRestore,
    noOptionsRestore: draft.noOptionsRestore,
    convertLegacyIndexes: draft.convertLegacyIndexes,
    maintainInsertionOrder: draft.maintainInsertionOrder,
    stopOnError: draft.stopOnError,
    bypassDocumentValidation: draft.bypassDocumentValidation,
    objcheck: draft.objcheck,
    writeConcern: draft.writeConcern,
    numParallelCollections: draft.numParallelCollections,
    numInsertionWorkersPerCollection: draft.numInsertionWorkersPerCollection,
    verifyChecksum: draft.verifyChecksum,
  });
}

/** Every problem with the draft, in the order the form shows the fields. */
export function restoreProblemsOf(
  draft: RestoreDraft,
  inspection: Pick<BackupInspection, 'namespaces' | 'hasOplog' | 'hasUsersAndRoles'>,
): BackupProblem[] {
  const problems: BackupProblem[] = [];
  if (renameRows(draft).length === 0 && draft.contents.length > 0) {
    problems.push({ field: 'include', message: 'Select something to restore' });
  }
  if (draft.toolsVersion === '') {
    problems.push({ field: 'toolsVersion', message: 'Choose a tools version' });
  }
  const oplogLimit = draft.oplogLimit.trim();
  if (oplogLimit !== '' && !/^\d{1,10}(:\d{1,10})?$/.test(oplogLimit)) {
    problems.push({
      field: 'oplogLimit',
      message: 'The oplog limit is seconds, or seconds:ordinal',
    });
  }
  const options = restoreOptionsOf(draft);
  problems.push(...restoreOptionProblems(options, inspection));
  return problems;
}

export interface RestoreStartContext {
  readonly connectionId: string;
  /** The path that was inspected. */
  readonly source: string;
  readonly acknowledged?: readonly FindingCode[];
  /** The typed connection name for a confirmable block. */
  readonly confirmation?: string | undefined;
}

/** The request for `backup.restore`. Call it only when `restoreProblemsOf` returns nothing. */
export function restoreStartInput(
  draft: RestoreDraft,
  context: RestoreStartContext,
): RestoreStartInput {
  return {
    connectionId: context.connectionId,
    source: context.source,
    toolsVersion: draft.toolsVersion,
    options: restoreOptionsOf(draft),
    acknowledged: [...(context.acknowledged ?? [])],
    ...(context.confirmation === undefined || context.confirmation === ''
      ? {}
      : { confirmation: context.confirmation }),
  };
}
