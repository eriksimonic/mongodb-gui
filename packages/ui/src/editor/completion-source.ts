import type { RpcClient, SchemaField } from '@mongo-gui/core';
import {
  completionContext,
  fieldCompletions,
  runtimeCompletions,
  type EditorCompletion,
} from './completion-model';

/** Documents sampled per collection for field names. */
export const FIELD_SAMPLE_SIZE = 100;

/** What the editor asks for on each completion. */
export interface CompletionSource {
  /**
   * Runtime completions and the sampled fields of the collection the statement names. Resolves to
   * no items when the signal aborts or the backend fails, so the static list still shows.
   */
  complete(code: string, offset: number, signal: AbortSignal): Promise<EditorCompletion[]>;
  /**
   * The sampled fields of a collection of the tab's database, from the same cache `complete`
   * uses. Resolves to no fields when the sample fails, and samples again on the next call.
   */
  fieldsOf(collection: string): Promise<SchemaField[]>;
  /**
   * The collection names of the tab's database, cached per database. Resolves to no names when
   * the listing fails, and lists again on the next call.
   */
  collections(): Promise<string[]>;
  /** Drops the cached field samples and collection names. The next completion asks again. */
  refreshFields(): void;
}

export interface CompletionSourceOptions {
  readonly rpc: RpcClient;
  readonly connectionId: string;
  /** Read on each call, because a tab can change its database. */
  readonly database: () => string;
  /**
   * True while the runtime evaluates code or steps a cursor. Completion and field sampling do not
   * set busy. The runtime handles one request at a time, so a completion sent during a run would
   * wait for the run. Busy skips the runtime and the sample until the run ends.
   */
  readonly isBusy: () => boolean;
}

/** Builds the completion source of one editor. The field samples are cached per collection. */
export function createCompletionSource(options: CompletionSourceOptions): CompletionSource {
  const samples = new Map<string, Promise<SchemaField[]>>();

  function sampleOf(database: string, collection: string): Promise<SchemaField[]> {
    const key = `${database}/${collection}`;
    const cached = samples.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const pending = options.rpc.shell
      .sampleSchema({
        connectionId: options.connectionId,
        database,
        collection,
        size: FIELD_SAMPLE_SIZE,
      })
      .then((sample) => {
        // An empty sample is not cached either. A collection that was missing or empty gets its
        // documents from an INSERT in the same editor, and it must complete after that.
        if (sample.fields.length === 0) {
          samples.delete(key);
        }
        return sample.fields;
      })
      .catch((): SchemaField[] => {
        // A failed sample is not cached, so the next completion tries again.
        samples.delete(key);
        return [];
      });
    samples.set(key, pending);
    return pending;
  }

  const collectionNames = new Map<string, Promise<string[]>>();

  function collectionsOf(database: string): Promise<string[]> {
    const cached = collectionNames.get(database);
    if (cached !== undefined) {
      return cached;
    }
    const pending = options.rpc.collections
      .list({ connectionId: options.connectionId, database })
      .then((collections) => collections.map((collection) => collection.name))
      .catch((): string[] => {
        collectionNames.delete(database);
        return [];
      });
    collectionNames.set(database, pending);
    return pending;
  }

  return {
    fieldsOf(collection) {
      return sampleOf(options.database(), collection);
    },

    collections() {
      return collectionsOf(options.database());
    },

    async complete(code, offset, signal) {
      if (signal.aborted || options.isBusy()) {
        return [];
      }
      const database = options.database();
      const context = completionContext(code, offset);
      const fieldsApply = context.collection !== undefined && !context.memberOfCollection;
      // The runtime completes one line. The folded statement up to the cursor is that line, so
      // a statement that spans lines still names its collection.
      const line = context.head + context.prefix;
      const [runtime, fields] = await Promise.all([
        options.rpc.shell
          .complete({
            connectionId: options.connectionId,
            database,
            code: line,
            position: line.length,
          })
          .then((response) => runtimeCompletions(response.items, context.head))
          .catch((): EditorCompletion[] => []),
        fieldsApply
          ? sampleOf(database, context.collection ?? '').then((sample) =>
              fieldCompletions(sample, context.objectKey, {
                parent: context.fieldParent,
                quoted: context.quotedKey,
              }),
            )
          : Promise.resolve<EditorCompletion[]>([]),
      ]);
      return signal.aborted ? [] : [...runtime, ...fields];
    },

    refreshFields() {
      samples.clear();
      collectionNames.clear();
    },
  };
}
