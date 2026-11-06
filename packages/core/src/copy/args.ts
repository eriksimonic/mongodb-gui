import { dumpArgs } from '../backup/dump-args';
import { DumpOptionsSchema, RestoreOptionsSchema } from '../backup/options';
import { collectionRenameArgs, restoreArgs, type NamespaceRef } from '../backup/restore-args';
import type { CopyMode } from './options';

export interface CopyDumpArgsInput {
  readonly configPath: string;
  readonly source: NamespaceRef;
  // Canonical EJSON object from the copy item. Undefined copies the whole collection.
  readonly filter?: string | undefined;
}

export interface CopyRestoreArgsInput {
  readonly configPath: string;
  // The namespace inside the archive, and the namespace to write.
  readonly source: NamespaceRef;
  readonly target: NamespaceRef;
  // Merge does not run mongorestore, so it has no restore argv.
  readonly mode: Exclude<CopyMode, 'merge'>;
  // The source is a time series collection. Its data sits in system.buckets.<name>, so that
  // namespace gets its own rename pair.
  readonly timeseries: boolean;
}

const bucketsOf = (ref: NamespaceRef): NamespaceRef => ({
  database: ref.database,
  collection: `system.buckets.${ref.collection}`,
});

/** The mongodump argv for one collection. The archive goes to stdout, uncompressed, for the pipe. */
export function copyDumpArgs(input: CopyDumpArgsInput): string[] {
  return dumpArgs({
    configPath: input.configPath,
    scope: {
      kind: 'collection',
      database: input.source.database,
      collection: input.source.collection,
    },
    options: DumpOptionsSchema.parse({ output: 'archive', gzip: false, query: input.filter }),
  });
}

/**
 * The mongorestore argv for one collection read from stdin. Replace passes --drop, insert only
 * passes --noIndexRestore. The rename flags come last. A time series source adds the pair for its
 * buckets after the collection pair, so each --nsFrom is followed by its --nsTo.
 */
export function copyRestoreArgs(input: CopyRestoreArgsInput): string[] {
  const options = RestoreOptionsSchema.parse({
    drop: input.mode === 'replace',
    noIndexRestore: input.mode === 'insertOnly',
  });
  return [
    // The archive is read from stdin, so the source path is not used.
    ...restoreArgs({
      configPath: input.configPath,
      source: '',
      inspection: { kind: 'archive', gzip: false },
      options,
    }),
    ...collectionRenameArgs(input.source, input.target),
    ...(input.timeseries
      ? collectionRenameArgs(bucketsOf(input.source), bucketsOf(input.target))
      : []),
  ];
}
