import {
  CollectionNameSchema,
  CopyModeSchema,
  type CollectionInfo,
  type CopyFindingCode,
  type CopyItem,
  type CopyMode,
  type CopyOptions,
} from '@mongo-gui/core';
import { checkEjsonObject } from '../transfers';

/** `one` has no checkboxes. `many` lists the offered collections. `database` lists all of them. */
export type CopyVariant = 'one' | 'many' | 'database';

/** One source collection and what the copy writes for it. */
export interface CopyRow {
  readonly source: string;
  readonly target: string;
  /** Extended JSON object text. Empty copies every document. */
  readonly filter: string;
  /** An unchecked row is not copied. */
  readonly included: boolean;
}

export const COPY_MODES: readonly CopyMode[] = CopyModeSchema.options;

export const MODE_LABELS: Readonly<Record<CopyMode, string>> = {
  replace: 'Drop and replace',
  merge: 'Merge',
  insertOnly: 'Insert only',
};

export const MODE_HELP: Readonly<Record<CopyMode, string>> = {
  replace: 'Restores into a temporary collection, then swaps it in. A cancel keeps the old data.',
  merge: 'Upserts by _id and copies documents only. Target indexes are not changed.',
  insertOnly: 'Skips documents whose _id already exists in the target.',
};

/** Views and system collections are not copied. The copy service skips them too. */
export function isCopyable(collection: {
  readonly name: string;
  readonly type?: CollectionInfo['type'] | undefined;
}): boolean {
  return collection.type !== 'view' && !collection.name.startsWith('system.');
}

/** One checked row per collection, each named after its source. */
export function rowsFor(collections: readonly string[]): CopyRow[] {
  return collections.map((source) => ({ source, target: source, filter: '', included: true }));
}

function includedOf(rows: readonly CopyRow[]): CopyRow[] {
  return rows.filter((row) => row.included);
}

/** The error for each row's target name. A name that two checked rows share is an error on both. */
export function targetNameErrors(rows: readonly CopyRow[]): (string | undefined)[] {
  const uses = new Map<string, number>();
  for (const row of includedOf(rows)) {
    uses.set(row.target, (uses.get(row.target) ?? 0) + 1);
  }
  return rows.map((row) => {
    if (!row.included) {
      return undefined;
    }
    if (!CollectionNameSchema.safeParse(row.target).success) {
      return 'Enter a valid collection name';
    }
    if ((uses.get(row.target) ?? 0) > 1) {
      return `Two items write to ${row.target}`;
    }
    return undefined;
  });
}

/** The filter error for each checked row, or undefined when the filter is empty or valid. */
export function filterErrors(rows: readonly CopyRow[]): (string | undefined)[] {
  return rows.map((row) => {
    if (!row.included) {
      return undefined;
    }
    const check = checkEjsonObject(`The filter for ${row.source}`, row.filter);
    return check.ok ? undefined : check.message;
  });
}

/** The items the copy writes. Checked rows only, with the filter left out when it is empty. */
export function copyItemsOf(rows: readonly CopyRow[]): CopyItem[] {
  return includedOf(rows).map((row) => {
    const filter = row.filter.trim();
    return filter === ''
      ? { source: row.source, target: row.target }
      : { source: row.source, target: row.target, filter };
  });
}

export interface CopyStartDraft {
  readonly sourceConnectionId: string;
  readonly targetConnectionId: string;
  readonly sourceDatabase: string;
  readonly targetDatabase: string;
  readonly rows: readonly CopyRow[];
  readonly mode: CopyMode;
  readonly acknowledged: readonly CopyFindingCode[];
  /** The typed target database name. Set only for a production target. */
  readonly confirmation: string | undefined;
}

export function copyStartInput(draft: CopyStartDraft): CopyOptions {
  return {
    sourceConnectionId: draft.sourceConnectionId,
    targetConnectionId: draft.targetConnectionId,
    sourceDatabase: draft.sourceDatabase,
    targetDatabase: draft.targetDatabase,
    items: copyItemsOf(draft.rows),
    mode: draft.mode,
    acknowledged: [...draft.acknowledged],
    ...(draft.confirmation === undefined ? {} : { confirmation: draft.confirmation }),
  };
}
