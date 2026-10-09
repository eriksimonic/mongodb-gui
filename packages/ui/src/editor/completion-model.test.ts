import { describe, expect, it } from 'vitest';
import {
  completionContext,
  fieldCompletions,
  lastCollection,
  mergeCompletions,
  operatorCompletions,
  runtimeCompletions,
} from './completion-model';
import { signatureAt } from './signature';
import { COLLECTION_METHODS, QUERY_OPERATORS, findMethod, methodLabel } from './operators';

describe('completionContext', () => {
  it('reads the word before the cursor', () => {
    const code = 'db.orders.find({ $gt';
    expect(completionContext(code, code.length).prefix).toBe('$gt');
  });

  it('names the collection of the statement', () => {
    const code = 'db.orders.find({ st';
    expect(completionContext(code, code.length)).toEqual({ prefix: 'st', collection: 'orders' });
  });

  it('has no collection outside a db expression', () => {
    expect(completionContext('pri', 3).collection).toBeUndefined();
  });

  it('does not take the collection from another statement', () => {
    const code = 'db.orders.countDocuments();\ndb.';
    expect(completionContext(code, code.length).collection).toBeUndefined();
  });
});

describe('lastCollection', () => {
  it('returns the last collection named in the text', () => {
    expect(lastCollection('db.a.find(); db.b.find(')).toBe('b');
  });

  it('skips database members that are not collections', () => {
    expect(lastCollection('db.orders.find(); db.getCollectionNames(')).toBe('orders');
  });

  it('returns undefined when no collection is named', () => {
    expect(lastCollection('print(1)')).toBeUndefined();
  });
});

describe('mergeCompletions', () => {
  const sources = [
    runtimeCompletions([
      { text: 'find', kind: 'method' },
      { text: 'findOne', kind: 'method' },
    ]),
    fieldCompletions([
      { path: 'status', types: ['string'], presence: 1 },
      { path: 'total', types: ['Double'], presence: 0.5 },
    ]),
    operatorCompletions(),
  ];

  it('keeps items that match the prefix, case-insensitively', () => {
    expect(mergeCompletions('FIN', sources).map((item) => item.label)).toEqual(['find', 'findOne']);
  });

  it('puts the runtime items before fields and operators', () => {
    const labels = mergeCompletions('', sources).map((item) => item.label);
    expect(labels.indexOf('find')).toBeLessThan(labels.indexOf('status'));
    expect(labels.indexOf('status')).toBeLessThan(labels.indexOf('$eq'));
  });

  it('puts operators first when the prefix starts with a dollar sign', () => {
    const items = mergeCompletions('$', sources);
    expect(items[0]?.kind).toBe('operator');
    expect(items.every((item) => item.label.startsWith('$'))).toBe(true);
  });

  it('keeps the first entry of a label that appears twice', () => {
    const duplicated = [
      runtimeCompletions([{ text: 'status', kind: 'property' }]),
      fieldCompletions([{ path: 'status', types: ['string'], presence: 1 }]),
    ];
    const items = mergeCompletions('st', duplicated);
    expect(items).toHaveLength(1);
    expect(items[0]?.rank).toBe(1);
  });

  it('caps the list', () => {
    expect(mergeCompletions('', sources, 3)).toHaveLength(3);
  });

  it('offers the field doc with the presence percentage', () => {
    const [field] = fieldCompletions([{ path: 'total', types: ['Double'], presence: 0.5 }]);
    expect(field?.doc).toBe('Present in 50 percent of the sampled documents.');
  });
});

describe('operator and method tables', () => {
  it('describes every operator with a non-empty doc and a dollar sign', () => {
    for (const operator of QUERY_OPERATORS) {
      expect(operator.name.startsWith('$')).toBe(true);
      expect(operator.doc.length).toBeGreaterThan(10);
    }
  });

  it('has no duplicate operator names', () => {
    const names = QUERY_OPERATORS.map((operator) => operator.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('labels methods with optional parameters in brackets', () => {
    expect(
      methodLabel(findMethod('find') ?? COLLECTION_METHODS[0] ?? { name: '', params: [], doc: '' }),
    ).toBe('find(filter, [projection])');
    expect(
      methodLabel(
        findMethod('updateOne') ?? COLLECTION_METHODS[0] ?? { name: '', params: [], doc: '' },
      ),
    ).toBe('updateOne(filter, update, [options])');
  });
});

describe('signatureAt', () => {
  it('shows the find signature with the first parameter active', () => {
    const code = 'db.orders.find(';
    expect(signatureAt(code, code.length)).toMatchObject({
      label: 'find(filter, [projection])',
      activeParameter: 0,
    });
  });

  it('moves the active parameter past each top-level comma', () => {
    const code = 'db.orders.find({ a: 1, b: 2 }, ';
    expect(signatureAt(code, code.length)?.activeParameter).toBe(1);
  });

  it('ignores commas inside nested literals', () => {
    const code = 'db.orders.find({ a: [1, 2, 3], ';
    expect(signatureAt(code, code.length)?.activeParameter).toBe(0);
  });

  it('ignores parentheses inside strings', () => {
    const code = 'db.orders.find("(", ';
    expect(signatureAt(code, code.length)?.activeParameter).toBe(1);
  });

  it('returns undefined outside a call the table knows', () => {
    expect(signatureAt('print(', 6)).toBeUndefined();
    expect(signatureAt('db.orders.find()', 16)).toBeUndefined();
  });

  it('gives the doc of an operator key', () => {
    const code = '{ $gt: ';
    expect(signatureAt(code, code.length)).toMatchObject({ label: '$gt(value)' });
  });
});
