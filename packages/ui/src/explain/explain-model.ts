import type { AppError, ExplainResult, KeyEntry, PlanStage, PlanVerbosity } from '@mongo-gui/core';

/** What the explain runs: a statement from the editor, or a command captured by the profiler. */
export type ExplainSource =
  | { readonly kind: 'statement'; readonly code: string }
  | {
      readonly kind: 'command';
      readonly commandEjson: string;
      readonly profileOp?: 'update' | 'remove';
      readonly collection?: string;
    };

export interface ExplainRequest {
  readonly connectionId: string;
  readonly database: string;
  readonly source: ExplainSource;
  readonly verbosity: PlanVerbosity;
}

export type ExplainOutcome =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly result: ExplainResult }
  | { readonly state: 'error'; readonly error: AppError }
  /** The statement is not one collection query, so nothing ran. */
  | { readonly state: 'refused'; readonly message: string };

export interface ExplainPanelState {
  readonly id: string;
  readonly title: string;
  /** The collection the plan is for. Undefined when the statement was refused. */
  readonly collection: string | undefined;
  /** The last request. Re-running changes the verbosity and keeps the rest. */
  readonly request: ExplainRequest;
  readonly outcome: ExplainOutcome;
}

/** Names the panel tab. Without a collection the title is the plain word. */
export function explainTitle(collection: string | undefined): string {
  return collection === undefined ? 'Explain' : `Explain · ${collection}`;
}

/** The collection a captured command runs on: the value of its first key when that is a string. */
export function commandCollection(commandEjson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(commandEjson);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const first = Object.entries(parsed as Record<string, unknown>)[0];
  return first !== undefined && typeof first[1] === 'string' && first[1] !== ''
    ? first[1]
    : undefined;
}

/** The metric the tree bars show. Documents when the server reports them, otherwise time. */
export type BarMetric = 'docs' | 'time';

export const ROOT_STAGE_ID = '0';

export interface StageEntry {
  readonly id: string;
  readonly stage: PlanStage;
}

/** Every stage of a plan in pre-order, with the path id the tree uses. */
export function stageEntries(root: PlanStage, prefix: string = ROOT_STAGE_ID): StageEntry[] {
  const entries: StageEntry[] = [];
  const visit = (stage: PlanStage, id: string): void => {
    entries.push({ id, stage });
    stage.children.forEach((child, index) => {
      visit(child, `${id}.${index}`);
    });
  };
  visit(root, prefix);
  return entries;
}

/** The value of a metric on one stage, or undefined when the server did not report it. */
export function metricOf(stage: PlanStage, metric: BarMetric): number | undefined {
  return metric === 'docs' ? stage.docsExamined : stage.executionTimeMs;
}

/** Documents when any stage reports a document count, otherwise time. */
export function barMetricFor(root: PlanStage): BarMetric {
  return stageEntries(root).some((entry) => entry.stage.docsExamined !== undefined)
    ? 'docs'
    : 'time';
}

/** The largest value of the metric in the plan. Zero when no stage reports it. */
export function maxMetric(root: PlanStage, metric: BarMetric): number {
  return stageEntries(root).reduce(
    (largest, entry) => Math.max(largest, metricOf(entry.stage, metric) ?? 0),
    0,
  );
}

/** Width of a bar in percent of the largest value. Zero when the value is unknown. */
export function barPercent(value: number | undefined, max: number): number {
  if (value === undefined || max <= 0) {
    return 0;
  }
  return Math.round((value / max) * 100);
}

/**
 * The hot stage: the highest document count, or the highest time when no stage reports documents.
 * Undefined when every value is zero or unknown.
 */
export function hotStageId(root: PlanStage): string | undefined {
  const metric = barMetricFor(root);
  let hot: StageEntry | undefined;
  let hotValue = 0;
  for (const entry of stageEntries(root)) {
    const value = metricOf(entry.stage, metric) ?? 0;
    if (value > hotValue) {
      hot = entry;
      hotValue = value;
    }
  }
  return hot?.id;
}

/** The first stage in pre-order with the given name. Warnings name their stage this way. */
export function stageIdByName(root: PlanStage, name: string): string | undefined {
  return stageEntries(root).find((entry) => entry.stage.name === name)?.id;
}

/**
 * The collapsed keys to drop so a stage shows: its ancestors and the labelled groups under them.
 * Groups are dropped by prefix, so opening a parent's group also opens its siblings.
 */
export function revealKeys(collapsed: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const ancestors = ancestorIds(id);
  return new Set(
    [...collapsed].filter(
      (key) =>
        !ancestors.some((ancestor) => key === ancestor || key.startsWith(groupKeyPrefix(ancestor))),
    ),
  );
}

/** The ids of the stages above a stage id, from the root down. */
export function ancestorIds(id: string): string[] {
  const parts = id.split('.');
  const ancestors: string[] = [];
  for (let length = 1; length < parts.length; length += 1) {
    ancestors.push(parts.slice(0, length).join('.'));
  }
  return ancestors;
}

export type PlanRow =
  | {
      readonly kind: 'stage';
      readonly id: string;
      readonly depth: number;
      readonly stage: PlanStage;
      readonly hasChildren: boolean;
      readonly expanded: boolean;
    }
  | {
      readonly kind: 'group';
      /** The collapse key of the group, which the collapsed set holds when the group is closed. */
      readonly id: string;
      /** The stage the group hangs under. */
      readonly parentId: string;
      readonly depth: number;
      readonly label: string;
      readonly expanded: boolean;
    };

/**
 * The collapse key of a labelled group. The group is the run of children that starts at `index`
 * under the stage `parentId`.
 */
export function groupKey(parentId: string, index: number): string {
  return `${groupKeyPrefix(parentId)}${index}`;
}

/** The prefix shared by the keys of every labelled group under one stage. */
export function groupKeyPrefix(parentId: string): string {
  return `${parentId}#group:`;
}

/**
 * The rows of a plan that are on screen, in display order. A collapsed stage hides its
 * descendants. Each run of siblings that share a label (a shard, a $facet branch, a $lookup inner
 * pipeline) gets a heading row that opens and closes the run.
 */
export function planRows(
  root: PlanStage,
  collapsed: ReadonlySet<string>,
  prefix: string = ROOT_STAGE_ID,
): PlanRow[] {
  const rows: PlanRow[] = [];
  const visit = (stage: PlanStage, id: string, depth: number): void => {
    const hasChildren = stage.children.length > 0;
    const expanded = hasChildren && !collapsed.has(id);
    rows.push({ kind: 'stage', id, depth, stage, hasChildren, expanded });
    if (!expanded) {
      return;
    }
    const children = stage.children;
    let index = 0;
    while (index < children.length) {
      const child = children[index];
      if (child?.label === undefined) {
        if (child !== undefined) {
          visit(child, `${id}.${index}`, depth + 1);
        }
        index += 1;
        continue;
      }
      let end = index + 1;
      while (end < children.length && children[end]?.label === child.label) {
        end += 1;
      }
      const key = groupKey(id, index);
      const open = !collapsed.has(key);
      rows.push({
        kind: 'group',
        id: key,
        parentId: id,
        depth: depth + 1,
        label: child.label,
        expanded: open,
      });
      if (open) {
        for (let member = index; member < end; member += 1) {
          const sibling = children[member];
          if (sibling !== undefined) {
            visit(sibling, `${id}.${member}`, depth + 1);
          }
        }
      }
      index = end;
    }
  };
  visit(root, prefix, 0);
  return rows;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function formatField(field: string): string {
  return IDENTIFIER.test(field) ? field : JSON.stringify(field);
}

/**
 * A mongosh line that creates an index with the given keys. Collection names that are not plain
 * identifiers go through getCollection.
 */
export function createIndexLine(collection: string, keys: readonly KeyEntry[]): string {
  const target = IDENTIFIER.test(collection)
    ? `db.${collection}`
    : `db.getCollection(${JSON.stringify(collection)})`;
  const pattern = keys
    .map(([field, direction]) => `${formatField(field)}: ${direction}`)
    .join(', ');
  return `${target}.createIndex({ ${pattern} })`;
}
