import { formatMongoshSyntax, type SchemaField } from '@mongo-gui/core';
import { chartPalette, seriesColor, type ChartScheme } from '../monitor/palette';

/** Sample sizes the panel offers. */
export const SAMPLE_SIZES = [100, 500, 1000, 5000] as const;
export type SampleSizeOption = (typeof SAMPLE_SIZES)[number];

/** A field below this presence is sparse. */
export const SPARSE_PRESENCE = 0.5;

export type SchemaSortKey = 'name' | 'types' | 'presence';
export type SortDirection = 'asc' | 'desc';

export interface SchemaSort {
  readonly key: SchemaSortKey;
  readonly direction: SortDirection;
}

export interface SchemaFilters {
  /** Text the path must contain, ignoring case. Empty means no path filter. */
  readonly text: string;
  readonly mixedOnly: boolean;
  readonly sparseOnly: boolean;
}

export const DEFAULT_SORT: SchemaSort = { key: 'presence', direction: 'desc' };
export const DEFAULT_FILTERS: SchemaFilters = { text: '', mixedOnly: false, sparseOnly: false };

/**
 * The first direction each key takes when chosen. Presence and type count start high, because the
 * fields that matter most are the common and the messy ones. Names start from A.
 */
const FIRST_DIRECTION: Readonly<Record<SchemaSortKey, SortDirection>> = {
  name: 'asc',
  types: 'desc',
  presence: 'desc',
};

/** Chooses a sort key. Choosing the active key again reverses the direction. */
export function toggleSort(current: SchemaSort, key: SchemaSortKey): SchemaSort {
  if (current.key === key) {
    return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { key, direction: FIRST_DIRECTION[key] };
}

/** Flips one path's open state. Paths that were never opened count as closed. */
export function toggleExpanded(
  expanded: Readonly<Record<string, boolean>>,
  path: string,
): Record<string, boolean> {
  return { ...expanded, [path]: expanded[path] !== true };
}

/** True when a filter narrows the rows. A narrowed view ignores the tree's open state. */
export function filtersActive(filters: SchemaFilters): boolean {
  return filters.text.trim() !== '' || filters.mixedOnly || filters.sparseOnly;
}

export function matchesFilters(field: SchemaField, filters: SchemaFilters): boolean {
  const text = filters.text.trim().toLowerCase();
  if (text !== '' && !field.path.toLowerCase().includes(text)) {
    return false;
  }
  if (filters.mixedOnly && field.types.length < 2) {
    return false;
  }
  if (filters.sparseOnly && field.presence >= SPARSE_PRESENCE) {
    return false;
  }
  return true;
}

export interface SchemaRow {
  readonly field: SchemaField;
  /** Number of ancestors the field has in the tree. Top-level fields are zero. */
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
}

export interface RowOptions {
  readonly filters: SchemaFilters;
  readonly sort: SchemaSort;
  readonly expanded: Readonly<Record<string, boolean>>;
}

interface TreeNode {
  readonly field: SchemaField;
  depth: number;
  readonly children: TreeNode[];
}

/**
 * The parent of a path is its longest prefix that is also a field. A prefix ends before a dot or
 * before "[]", so "items[].sku" has "items[]" as parent and "items[]" has "items".
 */
export function parentPath(path: string, paths: ReadonlySet<string>): string | undefined {
  for (let index = path.length - 1; index > 0; index -= 1) {
    const boundary = path[index] === '.' || path.startsWith('[]', index);
    if (!boundary) {
      continue;
    }
    const candidate = path.slice(0, index);
    if (paths.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function buildTree(fields: readonly SchemaField[]): TreeNode[] {
  const paths = new Set(fields.map((field) => field.path));
  const nodes = new Map<string, { field: SchemaField; children: TreeNode[]; depth: number }>();
  for (const field of fields) {
    nodes.set(field.path, { field, children: [], depth: 0 });
  }
  const roots: TreeNode[] = [];
  for (const field of fields) {
    const node = nodes.get(field.path);
    if (node === undefined) {
      continue;
    }
    const parent = parentPath(field.path, paths);
    const parentNode = parent === undefined ? undefined : nodes.get(parent);
    if (parentNode === undefined) {
      roots.push(node);
    } else {
      parentNode.children.push(node);
    }
  }
  assignDepths(roots, 0);
  return roots;
}

function assignDepths(nodes: TreeNode[], depth: number): void {
  for (const node of nodes) {
    node.depth = depth;
    assignDepths(node.children, depth + 1);
  }
}

/** Depth of every path in the tree. Used by the summary and the tests. */
export function depthByPath(fields: readonly SchemaField[]): Map<string, number> {
  const depths = new Map<string, number>();
  const visit = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      depths.set(node.field.path, node.depth);
      visit(node.children);
    }
  };
  visit(buildTree(fields));
  return depths;
}

function typeCountOf(field: SchemaField): number {
  return field.types.length;
}

function compareFields(sort: SchemaSort): (left: SchemaField, right: SchemaField) => number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  return (left, right) => {
    let order: number;
    if (sort.key === 'name') {
      order = left.path.localeCompare(right.path);
    } else if (sort.key === 'types') {
      order = typeCountOf(left) - typeCountOf(right);
    } else {
      order = left.presence - right.presence;
    }
    // Ties keep paths in A to Z order whichever way the key runs.
    return order === 0 ? left.path.localeCompare(right.path) : order * sign;
  };
}

/**
 * The rows the table shows, in tree order with siblings sorted. Without a filter, a row shows
 * only when every ancestor is open. With a filter, every matching row shows, indented by its
 * depth, so a match inside a closed branch still appears.
 */
export function buildRows(fields: readonly SchemaField[], options: RowOptions): SchemaRow[] {
  const filtering = filtersActive(options.filters);
  const compare = compareFields(options.sort);
  const rows: SchemaRow[] = [];
  const visit = (nodes: readonly TreeNode[]) => {
    const ordered = [...nodes].sort((left, right) => compare(left.field, right.field));
    for (const node of ordered) {
      const expanded = options.expanded[node.field.path] === true;
      const hasChildren = node.children.length > 0;
      if (!filtering || matchesFilters(node.field, options.filters)) {
        rows.push({ field: node.field, depth: node.depth, hasChildren, expanded });
      }
      if (hasChildren && (filtering || expanded)) {
        visit(node.children);
      }
    }
  };
  visit(buildTree(fields));
  return rows;
}

export interface SchemaTotals {
  readonly fields: number;
  readonly mixed: number;
  readonly sparse: number;
  readonly maxDepth: number;
}

export function summarizeTotals(fields: readonly SchemaField[]): SchemaTotals {
  const depths = depthByPath(fields);
  return {
    fields: fields.length,
    mixed: fields.filter((field) => field.types.length > 1).length,
    sparse: fields.filter((field) => field.presence < SPARSE_PRESENCE).length,
    maxDepth: Math.max(0, ...[...depths.values()]),
  };
}

export interface TypeTotal {
  readonly type: string;
  readonly count: number;
  /** Share of all values counted, from 0 to 1. */
  readonly share: number;
}

/** Values per BSON type across the top-level fields, largest first. */
export function topLevelTypeTotals(fields: readonly SchemaField[]): TypeTotal[] {
  const paths = new Set(fields.map((field) => field.path));
  const counts = new Map<string, number>();
  for (const field of fields) {
    if (parentPath(field.path, paths) !== undefined) {
      continue;
    }
    for (const [type, count] of typeShares(field)) {
      counts.set(type, (counts.get(type) ?? 0) + count);
    }
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count, share: total === 0 ? 0 : count / total }))
    .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type));
}

/** BSON types with a colour of their own, in fixed order. Other types share one neutral colour. */
export const TYPE_SLOTS = [
  'String',
  'Int32',
  'Double',
  'Boolean',
  'Date',
  'ObjectId',
  'Object',
  'Array',
] as const;

export const OTHER_TYPE = 'Other';

/** The legend bucket of a BSON type: its own name when it has a slot, otherwise "Other". */
export function typeBucket(type: string): string {
  return (TYPE_SLOTS as readonly string[]).includes(type) ? type : OTHER_TYPE;
}

export function typeColor(bucket: string, scheme: ChartScheme): string {
  const index = (TYPE_SLOTS as readonly string[]).indexOf(bucket);
  return index === -1 ? chartPalette(scheme).ink.muted : seriesColor(index, scheme);
}

/**
 * Each BSON type seen at a field with its count of values. A field without counts splits evenly
 * across its types, so older results still draw.
 */
export function typeShares(field: SchemaField): [string, number][] {
  if (field.typeCounts !== undefined && Object.keys(field.typeCounts).length > 0) {
    return Object.entries(field.typeCounts).filter(([, count]) => count > 0);
  }
  return field.types.map((type) => [type, 1]);
}

/** One segment of a field's bar: a bucket with its share of the field's values. */
export interface TypeSegment {
  readonly bucket: string;
  readonly types: readonly string[];
  readonly share: number;
}

/** Segments of a field's stacked bar in fixed bucket order. Types in "Other" merge into one. */
export function typeSegments(field: SchemaField): TypeSegment[] {
  const shares = typeShares(field);
  const total = shares.reduce((sum, [, count]) => sum + count, 0);
  const byBucket = new Map<string, { types: string[]; count: number }>();
  for (const [type, count] of shares) {
    const bucket = typeBucket(type);
    const entry = byBucket.get(bucket) ?? { types: [], count: 0 };
    entry.types.push(type);
    entry.count += count;
    byBucket.set(bucket, entry);
  }
  const order = [...TYPE_SLOTS, OTHER_TYPE] as string[];
  return order
    .filter((bucket) => byBucket.has(bucket))
    .map((bucket) => {
      const entry = byBucket.get(bucket);
      return {
        bucket,
        types: entry?.types.sort() ?? [],
        share: total === 0 ? 0 : (entry?.count ?? 0) / total,
      };
    });
}

/** The buckets a sample uses, in legend order. */
export function legendBuckets(fields: readonly SchemaField[]): string[] {
  const used = new Set<string>();
  for (const field of fields) {
    for (const segment of typeSegments(field)) {
      used.add(segment.bucket);
    }
  }
  return [...TYPE_SLOTS, OTHER_TYPE].filter((bucket) => used.has(bucket));
}

/** Path without array markers, as an index key or a query path. */
export function queryPath(path: string): string {
  return path.replaceAll('[]', '');
}

/** The mongosh expression for a collection, quoting names that are not identifiers. */
export function collectionExpression(collection: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(collection)
    ? `db.${collection}`
    : `db.getCollection(${JSON.stringify(collection)})`;
}

/** The query that lists the documents where a field is missing. */
export function missingFieldQuery(collection: string, path: string): string {
  return `${collectionExpression(collection)}.find({ ${JSON.stringify(queryPath(path))}: { $exists: false } })`;
}

/** A share as a whole percent. A share above zero that rounds to zero reads as "<1%". */
export function formatPercent(share: number): string {
  const percent = Math.round(share * 100);
  return share > 0 && percent === 0 ? '<1%' : `${percent}%`;
}

/** A distinct ratio. Below 10% it keeps one decimal, so 0.3% does not read as 0%. */
export function formatRatio(ratio: number): string {
  return ratio < 0.1 ? `${(ratio * 100).toFixed(1)}%` : formatPercent(ratio);
}

/** Milliseconds as a short time, in ms below a second and in seconds above. */
export function formatElapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/** Ranges in plain words, one entry per kind the field has. */
export function rangeLabels(field: SchemaField): string[] {
  const labels: string[] = [];
  if (field.numeric !== undefined) {
    labels.push(`${formatNumber(field.numeric.min)} to ${formatNumber(field.numeric.max)}`);
  }
  if (field.dateRange !== undefined) {
    labels.push(`${field.dateRange.min.slice(0, 10)} to ${field.dateRange.max.slice(0, 10)}`);
  }
  if (field.stringLengths !== undefined) {
    labels.push(`length ${field.stringLengths.min} to ${field.stringLengths.max}`);
  }
  if (field.arrayLengths !== undefined) {
    const { min, max, avg } = field.arrayLengths;
    labels.push(`array length ${min} to ${max}, average ${formatNumber(avg)}`);
  }
  return labels;
}

/**
 * The examples in mongosh notation, separated for a cell and a tooltip. An example cut to the
 * example length no longer parses, so it shows as stored.
 */
export function examplesText(field: SchemaField): string {
  return (field.examples ?? [])
    .map((example) => formatMongoshSyntax(example, { indent: 0 }))
    .join(', ');
}
