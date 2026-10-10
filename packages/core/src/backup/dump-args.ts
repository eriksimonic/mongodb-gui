import type { BackupScope, DumpOptions } from './options';

// One mongodump run covers one database at most, so a several-databases scope is split first.
export type DumpRunScope = Exclude<BackupScope, { kind: 'databases' }>;

export interface DumpArgsInput {
  readonly configPath: string;
  readonly scope: DumpRunScope;
  readonly options: DumpOptions;
  // The folder mongodump writes into. Required for the directory format; an archive goes to stdout.
  readonly outDir?: string | undefined;
}

/** The scopes of the mongodump runs one backup needs, in order. */
export function dumpRunScopes(scope: BackupScope): DumpRunScope[] {
  if (scope.kind === 'databases') {
    return scope.databases.map((database) => ({ kind: 'database', database }));
  }
  return [scope];
}

/**
 * The mongodump argv. The URI stays in the config file, so the argv holds no host or
 * credentials. Every value uses `--flag=value`, so a value starting with `-` cannot become a flag.
 */
export function dumpArgs(input: DumpArgsInput): string[] {
  const { scope, options } = input;
  const args = [`--config=${input.configPath}`];
  if (scope.kind !== 'server') {
    args.push(`--db=${scope.database}`);
  }
  if (scope.kind === 'collection') {
    args.push(`--collection=${scope.collection}`);
    if (options.query !== undefined) {
      args.push(`--query=${options.query}`);
    }
  }
  for (const collection of options.excludeCollections) {
    args.push(`--excludeCollection=${collection}`);
  }
  for (const prefix of options.excludeCollectionsWithPrefix) {
    args.push(`--excludeCollectionsWithPrefix=${prefix}`);
  }
  if (options.oplog) {
    args.push('--oplog');
  }
  if (options.dumpDbUsersAndRoles) {
    args.push('--dumpDbUsersAndRoles');
  }
  if (options.viewsAsCollections) {
    args.push('--viewsAsCollections');
  }
  if (options.forceTableScan) {
    args.push('--forceTableScan');
  }
  if (options.gzip) {
    args.push('--gzip');
  }
  args.push(`--numParallelCollections=${options.numParallelCollections}`);
  if (options.compressors.length > 0) {
    args.push(`--compressors=${options.compressors.join(',')}`);
  }
  if (options.output === 'archive') {
    // No value: the archive goes to stdout, which main hashes and writes.
    args.push('--archive');
  } else {
    if (input.outDir === undefined) {
      throw new Error('A directory dump needs an output folder');
    }
    args.push(`--out=${input.outDir}`);
  }
  return args;
}
