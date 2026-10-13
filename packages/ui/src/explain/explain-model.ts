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
  | { readonly state: 'refused'; readonly message: string }
  /** Restored from the saved layout. Nothing ran yet in this session. */
  | { readonly state: 'idle' };

export interface ExplainPanelState {
  readonly id: string;
  readonly title: string;
  /** The collection the plan is for. Undefined when the statement was refused. */
  readonly collection: string | undefined;
  /** The last request. Re-running changes the verbosity and keeps the rest. */
  readonly request: ExplainRequest;
  /** A line above the plan that says what was explained, for a measured $lookup pipeline. */
  readonly note?: string;
  readonly outcome: ExplainOutcome;
}

/** What a dock panel keeps in its params, so the saved layout can bring the panel back. */
export type ExplainRestore = Pick<ExplainPanelState, 'title' | 'collection' | 'request' | 'note'>;

/** The restore params of a panel. */
export function explainRestoreOf(panel: ExplainPanelState): ExplainRestore {
  return {
    title: panel.title,
    collection: panel.collection,
    request: panel.request,
    ...(panel.note === undefined ? {} : { note: panel.note }),
  };
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

/** Size of one stage card in the plan graph, and the space between cards, in pixels. */
export const GRAPH_NODE_WIDTH = 264;
export const GRAPH_NODE_HEIGHT = 96;
export const GRAPH_GAP_X = 24;
// Tall enough for the label of a sub-tree, which sits above its first card.
export const GRAPH_GAP_Y = 52;

export interface GraphNode {
  readonly id: string;
  readonly stage: PlanStage;
  /** Top left corner of the card. */
  readonly x: number;
  readonly y: number;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  /** Number of stages a collapsed card hides. Zero when it is expanded. */
  readonly hidden: number;
}

/** A line from a stage down to one of its inputs. */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
}

export interface PlanLayout {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly width: number;
  readonly height: number;
}

function stageCount(stage: PlanStage): number {
  return stage.children.reduce((sum, child) => sum + stageCount(child), 1);
}

/**
 * The plan as a tree of cards, root at the top and inputs below. Each sub-tree gets a column as
 * wide as its leaves, and a parent sits centred over its first and last input. A collapsed stage
 * hides its inputs and reports how many stages it hides.
 */
export function planLayout(
  root: PlanStage,
  collapsed: ReadonlySet<string>,
  prefix: string = ROOT_STAGE_ID,
): PlanLayout {
  const edges: GraphEdge[] = [];
  const widths = new Map<string, number>();
  const isOpen = (stage: PlanStage, id: string) => stage.children.length > 0 && !collapsed.has(id);

  const measure = (stage: PlanStage, id: string): number => {
    let width = GRAPH_NODE_WIDTH;
    if (isOpen(stage, id)) {
      const inner = stage.children.reduce(
        (sum, child, index) => sum + measure(child, `${id}.${index}`),
        GRAPH_GAP_X * (stage.children.length - 1),
      );
      width = Math.max(width, inner);
    }
    widths.set(id, width);
    return width;
  };

  let depthMax = 0;
  // Returns the card of the stage first, then the cards of its inputs, in pre-order.
  const place = (stage: PlanStage, id: string, left: number, depth: number): GraphNode[] => {
    depthMax = Math.max(depthMax, depth);
    const width = widths.get(id) ?? GRAPH_NODE_WIDTH;
    const open = isOpen(stage, id);
    const base = {
      id,
      stage,
      y: depth * (GRAPH_NODE_HEIGHT + GRAPH_GAP_Y),
      hasChildren: stage.children.length > 0,
      expanded: open,
    };
    if (!open) {
      const x = left + (width - GRAPH_NODE_WIDTH) / 2;
      return [{ ...base, x, hidden: stageCount(stage) - 1 }];
    }
    const inner =
      stage.children.reduce((sum, _, index) => sum + (widths.get(`${id}.${index}`) ?? 0), 0) +
      GRAPH_GAP_X * (stage.children.length - 1);
    let cursor = left + (width - inner) / 2;
    const subtrees = stage.children.map((child, index) => {
      const childId = `${id}.${index}`;
      edges.push({ from: id, to: childId });
      const placed = place(child, childId, cursor, depth + 1);
      cursor += (widths.get(childId) ?? 0) + GRAPH_GAP_X;
      return placed;
    });
    const first = subtrees[0]?.[0]?.x ?? left;
    const last = subtrees.at(-1)?.[0]?.x ?? left;
    return [{ ...base, x: (first + last) / 2, hidden: 0 }, ...subtrees.flat()];
  };

  const width = measure(root, prefix);
  const nodes = place(root, prefix, 0, 0);
  return {
    nodes,
    edges,
    width,
    height: (depthMax + 1) * GRAPH_NODE_HEIGHT + depthMax * GRAPH_GAP_Y,
  };
}

/**
 * The time a stage spent on its own. The server reports each stage's time with its inputs
 * included, so the inputs' times are taken off. Never below zero, because estimates can overlap.
 */
export function selfTimeMs(stage: PlanStage): number | undefined {
  if (stage.executionTimeMs === undefined) {
    return undefined;
  }
  const inputs = stage.children.reduce((sum, child) => sum + (child.executionTimeMs ?? 0), 0);
  return Math.max(0, stage.executionTimeMs - inputs);
}

export type StageTag = 'slowest' | 'largest' | 'most examined';

/**
 * The marks a stage card carries: the highest own time, the most documents returned and the most
 * documents examined. On a tie the mark goes to the last stage in pre-order, the one nearest the
 * data, since the stages above it only pass the documents on. No mark when the top value is 0.
 */
export function stageTags(entries: readonly StageEntry[]): ReadonlyMap<string, StageTag[]> {
  const tags = new Map<string, StageTag[]>();
  const mark = (tag: StageTag, value: (stage: PlanStage) => number | undefined): void => {
    let top: string | undefined;
    let topValue = 0;
    for (const entry of entries) {
      const current = value(entry.stage) ?? 0;
      if (current > 0 && current >= topValue) {
        top = entry.id;
        topValue = current;
      }
    }
    if (top !== undefined) {
      tags.set(top, [...(tags.get(top) ?? []), tag]);
    }
  };
  mark('slowest', selfTimeMs);
  mark('largest', (stage) => stage.nReturned);
  mark('most examined', (stage) => stage.docsExamined);
  return tags;
}

const EJSON_NUMBER_KEYS = ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal'];

// Canonical EJSON wraps every number, for example {"$numberInt": "3"}. The detail shows the number.
function plainNumbers(_: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const entries = Object.entries(value);
  const [key, text] = entries[0] ?? [];
  return entries.length === 1 && key !== undefined && EJSON_NUMBER_KEYS.includes(key)
    ? Number(text)
    : value;
}

/** JSON on one line, with plain keys unquoted and canonical EJSON numbers as numbers. */
export function compactJson(value: unknown): string {
  return (
    JSON.stringify(value, plainNumbers)
      ?.replace(/"([A-Za-z_$][\w$]*)":/g, '$1: ')
      .replace(/,/g, ', ') ?? ''
  );
}

/**
 * One line that says what a stage works on: its index, the collection it joins, the key it groups
 * or sorts by, or its filter. Undefined when the stage reports none of them.
 */
export function stageDetail(stage: PlanStage): string | undefined {
  if (stage.index !== undefined) {
    return stage.index;
  }
  const raw = typeof stage.raw === 'object' && stage.raw !== null ? stage.raw : {};
  const spec = (raw as Record<string, unknown>)[stage.name];
  const fields = typeof spec === 'object' && spec !== null ? (spec as Record<string, unknown>) : {};
  const from = fields['from'] ?? fields['coll'];
  if (typeof from === 'string') {
    return `from ${from}`;
  }
  if (stage.name === '$group' && fields['_id'] !== undefined) {
    return `by ${compactJson(fields['_id'])}`;
  }
  if (stage.sortPattern !== undefined) {
    return `by ${compactJson(stage.sortPattern)}`;
  }
  if (stage.filter !== undefined) {
    return compactJson(stage.filter);
  }
  // A pipeline stage without counters, such as one inside a $lookup pipeline, shows its spec.
  return stage.shard ?? (spec === undefined ? undefined : compactJson(spec));
}

/** Why a stage shows no numbers. */
export const UNMEASURED_TIP =
  'The server reports no counters for the stages inside a $lookup pipeline. The stage comes from the pipeline spec.';

/**
 * Whether the server reported any counter for the stage. It reports none for the stages inside a
 * $lookup pipeline, which the plan models from the pipeline spec.
 */
export function isMeasured(stage: PlanStage): boolean {
  return (
    stage.nReturned !== undefined ||
    stage.docsExamined !== undefined ||
    stage.keysExamined !== undefined ||
    stage.executionTimeMs !== undefined
  );
}

export interface LookupIndexUse {
  /** The indexes the inner pipeline or the join used, as the server lists them. */
  readonly indexes: readonly string[];
  /** How many times the join read the foreign collection without an index. */
  readonly collectionScans: number | undefined;
}

function rawNumber(value: unknown): number | undefined {
  const plain = plainNumbers('', value);
  return typeof plain === 'number' && Number.isFinite(plain) ? plain : undefined;
}

/**
 * The index use a $lookup or $graphLookup reports for the collection it joins: `indexesUsed` and
 * `collectionScans`. The server reports no plan for the inner pipeline, so this is the only
 * evidence of how it read the joined collection. Undefined for other stages.
 */
export function lookupIndexUse(stage: PlanStage): LookupIndexUse | undefined {
  const raw =
    typeof stage.raw === 'object' && stage.raw !== null
      ? (stage.raw as Record<string, unknown>)
      : {};
  const indexes = Array.isArray(raw['indexesUsed'])
    ? raw['indexesUsed'].filter((name): name is string => typeof name === 'string')
    : undefined;
  const collectionScans = rawNumber(raw['collectionScans']);
  if (indexes === undefined && collectionScans === undefined) {
    return undefined;
  }
  return { indexes: indexes ?? [], collectionScans };
}
