import {
  bsonTypeOf,
  cellView,
  isPlainObject,
  type BsonType,
  type JsonObject,
} from './result-model';

/** One visible line of the tree: a document, or a field inside one. */
export interface TreeRow {
  /** Unique across the result: the document index and the path. */
  readonly id: string;
  readonly documentIndex: number;
  /** Dotted path from the document root. Empty for the document itself. */
  readonly path: string;
  readonly key: string;
  readonly depth: number;
  readonly value: unknown;
  readonly type: BsonType;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
}

export interface TreeState {
  /** Whether every node with children is open. */
  readonly expandAll: boolean;
  /** Explicit open or closed state per row id. It wins over `expandAll`. */
  readonly overrides: Readonly<Record<string, boolean>>;
}

export const COLLAPSED: TreeState = { expandAll: false, overrides: {} };

export function rowIdOf(documentIndex: number, path: string): string {
  return `${documentIndex}:${path}`;
}

export function isOpen(state: TreeState, id: string): boolean {
  return state.overrides[id] ?? state.expandAll;
}

/** The children of a value: the fields of an object, or the elements of an array, in order. */
export function childrenOf(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) {
    return value.map((item, index) => [String(index), item]);
  }
  if (isPlainObject(value) && bsonTypeOf(value) === 'Object') {
    return Object.entries(value);
  }
  return [];
}

/**
 * The visible rows, depth first. A document is a row at depth zero, and its fields follow when it is
 * open. Only open nodes add rows, so the list stays as long as the screen needs, not the data.
 */
export function visibleRows(documents: readonly JsonObject[], state: TreeState): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (
    documentIndex: number,
    path: string,
    key: string,
    value: unknown,
    depth: number,
  ): void => {
    const children = childrenOf(value);
    const id = rowIdOf(documentIndex, path);
    const expanded = children.length > 0 && isOpen(state, id);
    rows.push({
      id,
      documentIndex,
      path,
      key,
      depth,
      value,
      type: bsonTypeOf(value),
      hasChildren: children.length > 0,
      expanded,
    });
    if (!expanded) {
      return;
    }
    for (const [childKey, child] of children) {
      visit(
        documentIndex,
        path === '' ? childKey : `${path}.${childKey}`,
        childKey,
        child,
        depth + 1,
      );
    }
  };
  documents.forEach((document, index) => {
    visit(index, '', `#${index + 1}`, document, 0);
  });
  return rows;
}

/** Text of a row's value column. */
export function valueTextOf(value: unknown): string {
  return cellView(value).text;
}

/** Text copied for "copy value": JSON for objects and arrays, the plain text otherwise. */
export function copyTextOf(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value, null, 2) ?? '';
  }
  return valueTextOf(value);
}
