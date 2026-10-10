import type { BackupInspection } from './inspection';
import type { DatabaseRename, RestoreOptions } from './options';

export interface RestoreArgsInput {
  readonly configPath: string;
  // The inspected archive file or dump folder.
  readonly source: string;
  readonly inspection: Pick<BackupInspection, 'kind' | 'layout' | 'gzip'>;
  readonly options: RestoreOptions;
}

/**
 * The mongorestore argv. The URI stays in the config file, so the argv holds no host or
 * credentials. Every value uses `--flag=value`, so a value starting with `-` cannot become a flag.
 */
export function restoreArgs(input: RestoreArgsInput): string[] {
  const { inspection, options } = input;
  const args = [`--config=${input.configPath}`];
  if (inspection.kind === 'archive') {
    // No value: main pipes the file to stdin.
    args.push('--archive');
  } else if (inspection.layout === 'database') {
    // A database folder restores through its parent. --db with --nsInclude restores nothing.
    const { parent, name } = splitPath(input.source);
    args.push(`--dir=${parent}`);
    if (options.include === undefined) {
      args.push(`--nsInclude=${escapeNamespacePart(name)}.*`);
    }
  } else {
    args.push(`--dir=${input.source}`);
  }
  if (inspection.gzip) {
    args.push('--gzip');
  }
  for (const selector of options.include ?? []) {
    args.push(`--nsInclude=${escapeSelector(selector)}`);
  }
  for (const rename of options.renames) {
    if (rename.from !== rename.to) {
      args.push(`--nsFrom=${escapeNamespacePart(rename.from)}.*`);
      args.push(`--nsTo=${escapeNamespacePart(rename.to)}.*`);
    }
  }
  if (options.drop) {
    args.push('--drop');
  }
  if (options.dryRun) {
    // Verbose output lists each namespace the dry run would restore.
    args.push('--dryRun', '-v');
  }
  if (options.oplogReplay) {
    args.push('--oplogReplay');
  }
  if (options.oplogLimit !== undefined) {
    args.push(`--oplogLimit=${options.oplogLimit}`);
  }
  const switches = [
    ['restoreDbUsersAndRoles', options.restoreDbUsersAndRoles],
    ['preserveUUID', options.preserveUUID],
    ['noIndexRestore', options.noIndexRestore],
    ['noOptionsRestore', options.noOptionsRestore],
    ['convertLegacyIndexes', options.convertLegacyIndexes],
    ['maintainInsertionOrder', options.maintainInsertionOrder],
    ['stopOnError', options.stopOnError],
    ['bypassDocumentValidation', options.bypassDocumentValidation],
    ['objcheck', options.objcheck],
  ] as const;
  for (const [flag, on] of switches) {
    if (on) {
      args.push(`--${flag}`);
    }
  }
  // 'majority' is the tool's default.
  if (options.writeConcern !== 'majority') {
    args.push(`--writeConcern=${options.writeConcern}`);
  }
  args.push(`--numParallelCollections=${options.numParallelCollections}`);
  args.push(`--numInsertionWorkersPerCollection=${options.numInsertionWorkersPerCollection}`);
  return args;
}

/** Escapes a database or collection name for --nsInclude, --nsFrom and --nsTo. */
export function escapeNamespacePart(name: string): string {
  return name.replace(/[\\*$]/g, (character) => `\\${character}`);
}

/** The namespace a source namespace is restored to after the database renames. */
export function applyRenames(namespace: string, renames: readonly DatabaseRename[]): string {
  const dot = namespace.indexOf('.');
  const database = dot === -1 ? namespace : namespace.slice(0, dot);
  const rename = renames.find((candidate) => candidate.from === database);
  if (rename === undefined) {
    return namespace;
  }
  return dot === -1 ? rename.to : `${rename.to}${namespace.slice(dot)}`;
}

// "db.*" keeps its wildcard; "db.coll" escapes both parts. The collection may hold dots.
function escapeSelector(selector: string): string {
  const dot = selector.indexOf('.');
  const database = escapeNamespacePart(selector.slice(0, dot));
  const collection = selector.slice(dot + 1);
  return `${database}.${collection === '*' ? '*' : escapeNamespacePart(collection)}`;
}

// Either separator, since the path may come from Windows.
function splitPath(path: string): { parent: string; name: string } {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const parent = trimmed.slice(0, cut);
  return {
    // The root itself, such as '/' or 'C:\'.
    parent: parent === '' || parent.endsWith(':') ? trimmed.slice(0, cut + 1) : parent,
    name: trimmed.slice(cut + 1),
  };
}
