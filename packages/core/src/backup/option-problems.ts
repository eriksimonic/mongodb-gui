import { DatabaseNameSchema } from '../management/types';
import type { BackupInspection } from './inspection';
import type { BackupScope, DumpOptions, RestoreOptions } from './options';
import type { BackupServerInfo } from './server-info';

export interface OptionProblem {
  // The option key the problem belongs to, such as 'oplog' or 'renames'.
  readonly field: string;
  readonly message: string;
}

const SYSTEM_DATABASES: ReadonlySet<string> = new Set(['admin', 'local', 'config']);

/**
 * Option combinations mongodump refuses or that make no sense for the scope. Without `server`
 * only the checks that need no server facts run; the start input schema runs those.
 */
export function dumpOptionProblems(
  scope: BackupScope,
  options: DumpOptions,
  server?: Pick<BackupServerInfo, 'topology'>,
): OptionProblem[] {
  const problems: OptionProblem[] = [];
  if (scope.kind === 'databases' && options.output === 'archive') {
    problems.push({ field: 'output', message: 'Several databases need the folder format.' });
  }
  if (options.query !== undefined) {
    if (scope.kind !== 'collection') {
      problems.push({ field: 'query', message: 'A query needs a single collection.' });
    } else if (!isJsonObject(options.query)) {
      problems.push({ field: 'query', message: 'The query must be an Extended JSON object.' });
    }
  }
  const databaseScope = scope.kind === 'database' || scope.kind === 'databases';
  if (options.excludeCollections.length > 0 && !databaseScope) {
    problems.push({
      field: 'excludeCollections',
      message: 'Collections can be excluded only when backing up databases.',
    });
  }
  if (options.excludeCollectionsWithPrefix.length > 0 && !databaseScope) {
    problems.push({
      field: 'excludeCollectionsWithPrefix',
      message: 'Collection prefixes can be excluded only when backing up databases.',
    });
  }
  if (options.oplog) {
    if (scope.kind !== 'server') {
      problems.push({
        field: 'oplog',
        message: 'The oplog can be included only for a whole server.',
      });
    } else if (server !== undefined && server.topology !== 'replicaSet') {
      problems.push({ field: 'oplog', message: 'The oplog needs a replica set.' });
    }
  }
  if (options.dumpDbUsersAndRoles) {
    if (!databaseScope) {
      problems.push({
        field: 'dumpDbUsersAndRoles',
        message: 'Users and roles can be included only when backing up databases.',
      });
    } else if (scopeDatabases(scope).includes('admin')) {
      problems.push({
        field: 'dumpDbUsersAndRoles',
        message: 'Users and roles of the admin database cannot be backed up this way.',
      });
    }
  }
  return problems;
}

/** Option combinations mongorestore refuses or that do not fit the backup. */
export function restoreOptionProblems(
  options: RestoreOptions,
  inspection: Pick<BackupInspection, 'namespaces' | 'hasOplog' | 'hasUsersAndRoles'>,
): OptionProblem[] {
  const problems: OptionProblem[] = [];
  const renames = options.renames.filter((rename) => rename.from !== rename.to);
  if (options.oplogReplay) {
    if (!inspection.hasOplog) {
      problems.push({ field: 'oplogReplay', message: 'The backup holds no oplog.' });
    }
    if (renames.length > 0) {
      problems.push({ field: 'oplogReplay', message: 'An oplog replay cannot rename databases.' });
    }
    if (isPartialInclude(options.include, inspection.namespaces)) {
      problems.push({
        field: 'oplogReplay',
        message: 'An oplog replay needs the whole backup to be restored.',
      });
    }
  }
  if (options.oplogLimit !== undefined && !options.oplogReplay) {
    problems.push({ field: 'oplogLimit', message: 'An oplog limit needs an oplog replay.' });
  }
  if (options.preserveUUID && !options.drop) {
    problems.push({
      field: 'preserveUUID',
      message: 'Keeping collection UUIDs needs dropping collections first.',
    });
  }
  if (options.restoreDbUsersAndRoles) {
    if (!inspection.hasUsersAndRoles) {
      problems.push({
        field: 'restoreDbUsersAndRoles',
        message: 'The backup holds no users or roles.',
      });
    }
    if (renames.length > 0) {
      problems.push({
        field: 'restoreDbUsersAndRoles',
        message: 'Users and roles cannot be restored while renaming databases.',
      });
    }
  }
  problems.push(...renameProblems(renames, selectedDatabases(options.include, inspection)));
  return problems;
}

/** Settings mongorestore needs together: keeping insertion order means one worker that stops on error. */
export function normaliseRestoreOptions(options: RestoreOptions): RestoreOptions {
  if (!options.maintainInsertionOrder) {
    return options;
  }
  return { ...options, stopOnError: true, numInsertionWorkersPerCollection: 1 };
}

function renameProblems(
  renames: RestoreOptions['renames'],
  selected: readonly string[],
): OptionProblem[] {
  const problems: OptionProblem[] = [];
  const sources = new Set(renames.map((rename) => rename.from));
  const seenSources = new Set<string>();
  const seenTargets = new Set<string>();
  for (const { from, to } of renames) {
    if (SYSTEM_DATABASES.has(from)) {
      problems.push({ field: 'renames', message: `The ${from} database cannot be renamed.` });
    }
    if (seenSources.has(from)) {
      problems.push({ field: 'renames', message: `${from} is renamed twice.` });
    }
    seenSources.add(from);
    if (!DatabaseNameSchema.safeParse(to).success) {
      problems.push({ field: 'renames', message: `${to} is not a valid database name.` });
    } else if (SYSTEM_DATABASES.has(to)) {
      problems.push({ field: 'renames', message: `A database cannot be renamed to ${to}.` });
    } else if (seenTargets.has(to)) {
      problems.push({ field: 'renames', message: `Two databases are renamed to ${to}.` });
    } else if (selected.includes(to) && !sources.has(to)) {
      problems.push({
        field: 'renames',
        message: `${to} is also restored under its own name.`,
      });
    }
    seenTargets.add(to);
  }
  return problems;
}

/** The source databases a restore selects: from `include`, else every database in the backup. */
function selectedDatabases(
  include: readonly string[] | undefined,
  inspection: Pick<BackupInspection, 'namespaces'>,
): string[] {
  const names =
    include === undefined
      ? inspection.namespaces.map((namespace) => namespace.database)
      : include.map((selector) => selector.slice(0, selector.indexOf('.')));
  return [...new Set(names)];
}

function isPartialInclude(
  include: readonly string[] | undefined,
  namespaces: BackupInspection['namespaces'],
): boolean {
  if (include === undefined) {
    return false;
  }
  const selectors = new Set(include);
  return namespaces.some(
    (namespace) =>
      !selectors.has(`${namespace.database}.*`) &&
      !selectors.has(`${namespace.database}.${namespace.collection}`),
  );
}

function scopeDatabases(scope: BackupScope): string[] {
  switch (scope.kind) {
    case 'server':
      return [];
    case 'databases':
      return scope.databases;
    case 'database':
    case 'collection':
      return [scope.database];
  }
}

function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}
