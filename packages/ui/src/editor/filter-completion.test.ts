import type { SchemaField } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { filterCompletions } from './filter-completion';

function field(path: string, types: readonly string[] = ['string']): SchemaField {
  return { path, types: [...types], presence: 1 };
}

const FIELDS: readonly SchemaField[] = [
  field('customer', ['object']),
  field('customer.name'),
  field('customer.address.city'),
  field('items', ['array']),
  field('items[].sku'),
  field('status'),
  field('total', ['double']),
];

function labels(head: string, fields: readonly SchemaField[] = FIELDS): string[] {
  return filterCompletions(head, fields).items.map((item) => item.label);
}

function item(head: string, label: string, fields: readonly SchemaField[] = FIELDS) {
  return filterCompletions(head, fields).items.find((candidate) => candidate.label === label);
}

describe('filterCompletions, property position', () => {
  it('offers the top-level fields and the operators in an object at the root', () => {
    const result = filterCompletions('{', FIELDS);

    expect(result.replaceLength).toBe(0);
    expect(labels('{')).toEqual(expect.arrayContaining(['status', 'customer', '$gt', '$and']));
  });

  it('double-quotes the inserted key when the cursor is outside quotes', () => {
    expect(item('{', 'status')).toMatchObject({
      kind: 'property',
      detail: 'string',
      insertText: '"status"',
    });
    expect(item('{', '$gt')).toMatchObject({ kind: 'operator', insertText: '"$gt"' });
  });

  it('replaces the bare word that is typed before the cursor', () => {
    expect(filterCompletions('{ sta', FIELDS).replaceLength).toBe(3);
    expect(filterCompletions('{"status": 1, to', FIELDS).replaceLength).toBe(2);
  });

  it('offers the fields again after a comma', () => {
    expect(labels('{"status": "paid", ')).toContain('total');
  });

  it('gives the bare name inside quotes, so the closing quote stays', () => {
    const result = filterCompletions('{"sta', FIELDS);

    expect(result.replaceLength).toBe(3);
    expect(item('{"sta', 'status')?.insertText).toBe('status');
    expect(item('{"', '$gt')?.insertText).toBe('$gt');
  });

  it('gives the dotted path of a nested field inside quotes', () => {
    const result = filterCompletions('{"customer.ad', FIELDS);

    expect(result.replaceLength).toBe('customer.ad'.length);
    expect(item('{"customer.ad', 'customer.address.city')?.insertText).toBe(
      'customer.address.city',
    );
  });

  it('offers the dotted path of a nested field as one double-quoted key', () => {
    expect(item('{ cust', 'customer.address.city')?.insertText).toBe('"customer.address.city"');
  });

  it('offers fields relative to the object the cursor is in', () => {
    const relative = labels('{"customer": {');

    expect(relative).toEqual(expect.arrayContaining(['name', 'address.city']));
    expect(relative).not.toContain('customer');
    expect(relative).not.toContain('customer.name');
    expect(item('{"customer": {', 'address.city')?.insertText).toBe('"address.city"');
  });

  it('offers the sub-fields of an array of objects under the array key', () => {
    expect(item('{"items": [{', 'sku')?.insertText).toBe('"sku"');
  });

  it('keeps the top-level fields inside an $and array of filters', () => {
    const inside = labels('{"$and": [{');

    expect(inside).toContain('status');
    expect(inside).not.toContain('$and.status');
  });

  it('offers the sampled fields only when the sample has them', () => {
    expect(labels('{', [])).toEqual(expect.arrayContaining(['$gt']));
    expect(labels('{', [])).not.toContain('status');
  });
});

describe('filterCompletions, operator choice and order', () => {
  const COMMON = [
    '$eq',
    '$ne',
    '$gt',
    '$gte',
    '$lt',
    '$lte',
    '$in',
    '$nin',
    '$exists',
    '$regex',
    '$and',
    '$or',
  ];

  it('offers query operators only, never update, pipeline or expression operators', () => {
    const names = labels('{');

    expect(names).toEqual(expect.arrayContaining(['$where', '$expr', '$text', '$nor', '$not']));
    for (const name of ['$add', '$set', '$group', '$graphLookup', '$cond', '$inc']) {
      expect(names).not.toContain(name);
    }
  });

  it('lists the fields before the operators, and the common operators in use order', () => {
    const names = labels('{');
    const firstOperator = names.findIndex((name) => name.startsWith('$'));

    expect(firstOperator).toBeGreaterThan(0);
    expect(names.slice(0, firstOperator).every((name) => !name.startsWith('$'))).toBe(true);
    expect(names.slice(firstOperator, firstOperator + COMMON.length)).toEqual(COMMON);
  });

  it('ranks $gt and $gte first for a typed $g', () => {
    const names = labels('{"total": {"$g').filter((name) => name.startsWith('$g'));

    expect(names).toEqual(['$gt', '$gte']);
  });
});

describe('filterCompletions, operator position', () => {
  it('offers the operators in an operator object', () => {
    expect(labels('{"total": {')).toEqual(expect.arrayContaining(['$gt', '$in']));
  });

  it('keeps the query operators with their docs', () => {
    expect(item('{', '$and')).toMatchObject({ kind: 'operator' });
    expect(item('{', '$and')?.doc).toBeTruthy();
  });

  it('replaces a typed operator name, and keeps the bare name inside quotes', () => {
    const result = filterCompletions('{"total": {"$g', FIELDS);

    expect(result.replaceLength).toBe(2);
    expect(item('{"total": {"$g', '$gt')?.insertText).toBe('$gt');
  });
});

describe('filterCompletions, value position', () => {
  const EJSON = ['$oid', '$date', '$numberLong', '$regularExpression'];

  it('offers the Extended JSON forms after a colon, and no fields or operators', () => {
    const names = labels('{"status": ');

    expect(names).toEqual(expect.arrayContaining(EJSON));
    expect(names).not.toContain('status');
    expect(names).not.toContain('$gt');
  });

  it('offers the Extended JSON forms after an operator key', () => {
    expect(labels('{"total": {"$gt": ')).toEqual(expect.arrayContaining(EJSON));
  });

  it('offers the Extended JSON forms as array elements', () => {
    expect(labels('{"status": {"$in": [')).toEqual(expect.arrayContaining(EJSON));
  });

  it('inserts each form as a snippet with a double-quoted key and the cursor in the value', () => {
    expect(item('{"status": ', '$oid')).toMatchObject({
      kind: 'method',
      detail: '{"$oid": ""}',
      insertText: '{"\\$oid": "$1"}',
      snippet: true,
    });
    expect(item('{"status": ', '$regularExpression')?.insertText).toBe(
      '{"\\$regularExpression": {"pattern": "$1", "options": ""}}',
    );
  });

  it('replaces a typed value word', () => {
    const result = filterCompletions('{"status": $o', FIELDS);

    expect(result.replaceLength).toBe(2);
    expect(result.items.map((candidate) => candidate.label)).toContain('$oid');
  });

  it('offers nothing inside a string value', () => {
    expect(filterCompletions('{"status": "pa', FIELDS)).toEqual({ replaceLength: 0, items: [] });
  });
});

describe('filterCompletions, no completion', () => {
  it('offers nothing before the opening brace', () => {
    expect(filterCompletions('', FIELDS)).toEqual({ replaceLength: 0, items: [] });
  });

  it('offers nothing after a closed key, where a colon comes next', () => {
    expect(filterCompletions('{"status"', FIELDS)).toEqual({ replaceLength: 0, items: [] });
  });
});
