import type { SchemaField } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { CHART_INK, CHART_COLORS } from '../monitor/palette';
import {
  buildRows,
  collectionExpression,
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  depthByPath,
  examplesText,
  formatRatio,
  missingFieldQuery,
  parentPath,
  rangeLabels,
  summarizeTotals,
  toggleExpanded,
  toggleSort,
  topLevelTypeTotals,
  typeBucket,
  typeColor,
  typeSegments,
  type SchemaFilters,
} from './schema-model';

function field(path: string, overrides: Partial<SchemaField> = {}): SchemaField {
  return { path, types: ['String'], presence: 1, ...overrides };
}

// A typical nested shape: a flat root, a nested object, and an array of documents.
const FIELDS: SchemaField[] = [
  field('_id', { types: ['ObjectId'], typeCounts: { ObjectId: 10 } }),
  field('status', { types: ['String'], typeCounts: { String: 10 } }),
  field('amount', {
    types: ['Double', 'Int32'],
    typeCounts: { Double: 3, Int32: 7 },
    presence: 0.4,
  }),
  field('customer', { types: ['Object'], typeCounts: { Object: 10 } }),
  field('customer.name', { types: ['String'], typeCounts: { String: 10 } }),
  field('customer.address', { types: ['Object'], typeCounts: { Object: 8 }, presence: 0.8 }),
  field('customer.address.city', { types: ['String'], typeCounts: { String: 8 }, presence: 0.8 }),
  field('items', { types: ['Array'], typeCounts: { Array: 10 } }),
  field('items[]', { types: ['Object'], typeCounts: { Object: 25 }, presence: 1 }),
  field('items[].sku', { types: ['String'], typeCounts: { String: 25 } }),
  field('items[].qty', { types: ['Int32', 'String'], typeCounts: { Int32: 20, String: 5 } }),
];

const NO_FILTERS: SchemaFilters = DEFAULT_FILTERS;

function paths(rows: { field: SchemaField }[]): string[] {
  return rows.map((row) => row.field.path);
}

describe('parentPath', () => {
  const all = new Set(FIELDS.map((item) => item.path));

  it('finds the nearest existing prefix across dots and array markers', () => {
    expect(parentPath('customer.address.city', all)).toBe('customer.address');
    expect(parentPath('items[].sku', all)).toBe('items[]');
    expect(parentPath('items[]', all)).toBe('items');
    expect(parentPath('status', all)).toBeUndefined();
  });

  it('skips prefixes that are not fields', () => {
    expect(parentPath('a.b.c', new Set(['a', 'a.b.c']))).toBe('a');
  });
});

describe('depthByPath', () => {
  it('counts ancestors, with array elements one level under their array', () => {
    const depths = depthByPath(FIELDS);
    expect(depths.get('status')).toBe(0);
    expect(depths.get('customer.address.city')).toBe(2);
    expect(depths.get('items')).toBe(0);
    expect(depths.get('items[]')).toBe(1);
    expect(depths.get('items[].sku')).toBe(2);
  });
});

describe('buildRows', () => {
  it('shows only top-level rows while nothing is open', () => {
    const rows = buildRows(FIELDS, { filters: NO_FILTERS, sort: DEFAULT_SORT, expanded: {} });
    // Presence descends, so the partly present amount comes last.
    expect(paths(rows)).toEqual(['_id', 'customer', 'items', 'status', 'amount']);
    expect(rows.find((row) => row.field.path === 'customer')).toMatchObject({
      depth: 0,
      hasChildren: true,
      expanded: false,
    });
  });

  it('shows the children of an open row, one level at a time', () => {
    const once = buildRows(FIELDS, {
      filters: NO_FILTERS,
      sort: { key: 'name', direction: 'asc' },
      expanded: { customer: true },
    });
    expect(paths(once)).toEqual([
      '_id',
      'amount',
      'customer',
      'customer.address',
      'customer.name',
      'items',
      'status',
    ]);
    const deep = buildRows(FIELDS, {
      filters: NO_FILTERS,
      sort: { key: 'name', direction: 'asc' },
      expanded: { customer: true, 'customer.address': true, items: true, 'items[]': true },
    });
    expect(paths(deep)).toContain('customer.address.city');
    expect(paths(deep)).toContain('items[].sku');
    expect(deep.find((row) => row.field.path === 'items[].sku')?.depth).toBe(2);
  });

  it('shows every match inside closed branches when a filter is active', () => {
    const rows = buildRows(FIELDS, {
      filters: { ...NO_FILTERS, text: 'CITY' },
      sort: DEFAULT_SORT,
      expanded: {},
    });
    expect(paths(rows)).toEqual(['customer.address.city']);
    expect(rows[0]?.depth).toBe(2);
  });

  it('keeps only mixed-type fields when the mixed filter is on', () => {
    const rows = buildRows(FIELDS, {
      filters: { ...NO_FILTERS, mixedOnly: true },
      sort: { key: 'name', direction: 'asc' },
      expanded: {},
    });
    expect(paths(rows)).toEqual(['amount', 'items[].qty']);
  });

  it('keeps only fields under half presence when the sparse filter is on', () => {
    const rows = buildRows(FIELDS, {
      filters: { ...NO_FILTERS, sparseOnly: true },
      sort: { key: 'name', direction: 'asc' },
      expanded: {},
    });
    expect(paths(rows)).toEqual(['amount']);
  });

  it('sorts siblings by presence, name or type count', () => {
    const byPresence = buildRows(FIELDS, {
      filters: NO_FILTERS,
      sort: { key: 'presence', direction: 'asc' },
      expanded: {},
    });
    expect(paths(byPresence)).toEqual(['amount', '_id', 'customer', 'items', 'status']);

    const byName = buildRows(FIELDS, {
      filters: NO_FILTERS,
      sort: { key: 'name', direction: 'desc' },
      expanded: {},
    });
    expect(paths(byName)).toEqual(['status', 'items', 'customer', 'amount', '_id']);

    const byTypes = buildRows(FIELDS, {
      filters: NO_FILTERS,
      sort: { key: 'types', direction: 'desc' },
      expanded: {},
    });
    expect(paths(byTypes)[0]).toBe('amount');
  });

  it('marks an open row as expanded', () => {
    const rows = buildRows(FIELDS, {
      filters: NO_FILTERS,
      sort: DEFAULT_SORT,
      expanded: { customer: true },
    });
    expect(rows.find((row) => row.field.path === 'customer')?.expanded).toBe(true);
  });
});

describe('toggleSort', () => {
  it('reverses the direction of the active key and starts new keys at their first direction', () => {
    expect(toggleSort(DEFAULT_SORT, 'presence')).toEqual({ key: 'presence', direction: 'asc' });
    expect(toggleSort(DEFAULT_SORT, 'name')).toEqual({ key: 'name', direction: 'asc' });
    expect(toggleSort({ key: 'name', direction: 'asc' }, 'name')).toEqual({
      key: 'name',
      direction: 'desc',
    });
    expect(toggleSort(DEFAULT_SORT, 'types')).toEqual({ key: 'types', direction: 'desc' });
  });
});

describe('toggleExpanded', () => {
  it('flips one path and leaves the others alone', () => {
    const opened = toggleExpanded({ a: true }, 'b');
    expect(opened).toEqual({ a: true, b: true });
    expect(toggleExpanded(opened, 'a')).toEqual({ a: false, b: true });
  });
});

describe('summarizeTotals', () => {
  it('counts fields, mixed and sparse fields, and the deepest nesting', () => {
    expect(summarizeTotals(FIELDS)).toEqual({ fields: 11, mixed: 2, sparse: 1, maxDepth: 2 });
  });

  it('reports zero for an empty sample', () => {
    expect(summarizeTotals([])).toEqual({ fields: 0, mixed: 0, sparse: 0, maxDepth: 0 });
  });
});

describe('topLevelTypeTotals', () => {
  it('sums value counts of top-level fields by BSON type, largest first', () => {
    const totals = topLevelTypeTotals(FIELDS);
    expect(totals.map((item) => [item.type, item.count])).toEqual([
      ['Array', 10],
      ['Object', 10],
      ['ObjectId', 10],
      ['String', 10],
      ['Int32', 7],
      ['Double', 3],
    ]);
    expect(totals.reduce((sum, item) => sum + item.share, 0)).toBeCloseTo(1);
  });
});

describe('type colours', () => {
  it('gives each slot type its palette colour in fixed order', () => {
    expect(typeColor(typeBucket('String'))).toBe(CHART_COLORS[0]);
    expect(typeColor(typeBucket('Date'))).toBe(CHART_COLORS[4]);
  });

  it('folds types without a slot into one neutral Other bucket', () => {
    expect(typeBucket('Null')).toBe('Other');
    expect(typeBucket('Long')).toBe('Other');
    expect(typeColor('Other')).toBe(CHART_INK.muted);
  });

  it('builds a stacked bar whose shares add up, merging Other types', () => {
    const segments = typeSegments(
      field('mixed', {
        types: ['Long', 'Null', 'String'],
        typeCounts: { Long: 1, Null: 1, String: 2 },
      }),
    );
    expect(segments.map((segment) => segment.bucket)).toEqual(['String', 'Other']);
    expect(segments[0]?.share).toBe(0.5);
    expect(segments[1]?.types).toEqual(['Long', 'Null']);
    expect(segments[1]?.share).toBe(0.5);
  });

  it('splits a field without counts evenly across its types', () => {
    const segments = typeSegments(field('legacy', { types: ['String', 'Int32'] }));
    expect(segments.map((segment) => segment.share)).toEqual([0.5, 0.5]);
  });
});

describe('formatRatio', () => {
  it('shows whole percents from 10% up and one decimal below', () => {
    expect(formatRatio(0.003)).toBe('0.3%');
    expect(formatRatio(0.095)).toBe('9.5%');
    expect(formatRatio(0.37)).toBe('37%');
    expect(formatRatio(1)).toBe('100%');
  });
});

describe('query and label helpers', () => {
  it('builds the missing-field query with array markers removed', () => {
    expect(missingFieldQuery('orders', 'items[].sku')).toBe(
      'db.orders.find({ "items.sku": { $exists: false } })',
    );
  });

  it('quotes collection names that are not identifiers', () => {
    expect(collectionExpression('app-logs')).toBe('db.getCollection("app-logs")');
  });

  it('describes numeric, date, length and array ranges in words', () => {
    expect(
      rangeLabels(
        field('x', {
          numeric: { min: -4, max: 100 },
          dateRange: { min: '2023-12-31T23:30:00.000Z', max: '2025-01-15T00:00:00.000Z' },
          stringLengths: { min: 2, max: 9 },
          arrayLengths: { min: 0, max: 3, avg: 1.5 },
        }),
      ),
    ).toEqual([
      '-4 to 100',
      '2023-12-31 to 2025-01-15',
      'length 2 to 9',
      'array length 0 to 3, average 1.5',
    ]);
  });

  it('joins examples for a tooltip', () => {
    expect(examplesText(field('x', { examples: ['"a"', '"b"'] }))).toBe('"a", "b"');
  });
});
