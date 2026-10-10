import { describe, expect, it } from 'vitest';
import {
  completionContext,
  staticCompletionsFor,
  fieldCompletions,
  lastCollection,
  mergeCompletions,
  operatorCompletions,
  operatorsFor,
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
    expect(completionContext(code, code.length)).toEqual({
      prefix: 'st',
      collection: 'orders',
      head: 'db.orders.find({ ',
      memberOfCollection: false,
      objectKey: true,
      quotedKey: false,
      fieldParent: undefined,
      valuePosition: false,
      cursorMember: false,
    });
  });

  it('names the collection inside a find call, where field completion applies', () => {
    const code = 'db.users.find({ na';
    expect(completionContext(code, code.length)).toMatchObject({
      prefix: 'na',
      collection: 'users',
      objectKey: true,
    });
  });

  it('names the collection of a db.getCollection or db[...] statement', () => {
    const quoted = 'db.getCollection("users").find({ na';
    expect(completionContext(quoted, quoted.length)).toMatchObject({
      prefix: 'na',
      collection: 'users',
      objectKey: true,
    });
    const bracket = "db['users'].find({ na";
    expect(completionContext(bracket, bracket.length)).toMatchObject({
      collection: 'users',
      objectKey: true,
    });
  });

  it('reports the line text before the word, not the text of earlier lines', () => {
    const code = 'use shop\ndb.ord';
    expect(completionContext(code, code.length)).toMatchObject({ prefix: 'ord', head: 'db.' });
  });

  it('marks the position right after db.<collection>.', () => {
    const code = 'db.orders.fi';
    expect(completionContext(code, code.length)).toMatchObject({
      prefix: 'fi',
      memberOfCollection: true,
    });
  });

  it('has no collection outside a db expression', () => {
    expect(completionContext('pri', 3).collection).toBeUndefined();
  });

  it('handles an offset at the start of the text', () => {
    expect(completionContext('\ndb', 0)).toMatchObject({ prefix: '', head: '' });
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

  it('reads a collection named with db.getCollection', () => {
    expect(lastCollection('db.getCollection("orders").find(')).toBe('orders');
    expect(lastCollection("db.getCollection('orders').find(")).toBe('orders');
  });

  it('reads a collection named with db[...]', () => {
    expect(lastCollection("db['orders'].find(")).toBe('orders');
    expect(lastCollection('db["orders"].find(')).toBe('orders');
  });

  it('takes the last collection whichever form names it', () => {
    expect(lastCollection('db.a.find(); db["b"].find(); db.getCollection("c").find(')).toBe('c');
  });
});

describe('runtimeCompletions', () => {
  // The runtime returns whole-line texts, so these are the shapes the editor receives.
  it('turns the whole-line texts after db. into collection names', () => {
    const items = runtimeCompletions(
      [
        { text: 'db.adminCommand', kind: 'method' },
        { text: 'db.orders', kind: 'collection' },
      ],
      'db.',
    );
    expect(items.map((item) => item.label)).toEqual(['adminCommand', 'orders']);
    expect(mergeCompletions('ord', [items]).map((item) => item.label)).toEqual(['orders']);
  });

  it('keeps only the part after the typed word, so accepting does not repeat the prefix', () => {
    const items = runtimeCompletions([{ text: 'db.orders.find', kind: 'method' }], 'db.orders.');
    expect(items).toEqual([{ label: 'find', kind: 'method', rank: 1 }]);
  });

  it('drops texts that do not share the line text before the word', () => {
    const items = runtimeCompletions(
      [
        { text: 'db.orders.find', kind: 'method' },
        { text: 'print', kind: 'method' },
      ],
      'db.orders.',
    );
    expect(items.map((item) => item.label)).toEqual(['find']);
  });

  it('ranks runtime methods above operators unless the prefix starts with a dollar sign', () => {
    const methods = runtimeCompletions([{ text: 'db.orders.find', kind: 'method' }], 'db.orders.');
    const sources = [methods, operatorCompletions()];
    expect(mergeCompletions('f', sources)[0]?.label).toBe('find');
    expect(mergeCompletions('$', sources)[0]?.kind).toBe('operator');
  });
});

describe('operatorsFor', () => {
  it('offers no operators after db. or on a collection member', () => {
    const code = 'db.orders.';
    expect(operatorsFor(completionContext(code, code.length))).toEqual([]);
  });

  it('offers operators in an object key and after a dollar sign', () => {
    const code = 'db.orders.find({ ';
    expect(operatorsFor(completionContext(code, code.length)).length).toBeGreaterThan(0);
    const dollar = '$gt';
    expect(operatorsFor(completionContext(dollar, dollar.length)).length).toBeGreaterThan(0);
  });
});

describe('fieldCompletions ranking', () => {
  it('lists shallow paths before deep ones, so a large map does not hide the top-level fields', () => {
    const fields = [
      ...Array.from({ length: 300 }, (_, index) => ({
        path: `definitions.${1000 + index}.enumFlags`,
        types: ['bool'],
        presence: 1,
      })),
      { path: 'name', types: ['string'], presence: 1 },
      { path: 'definitions', types: ['object'], presence: 1 },
    ];

    const labels = mergeCompletions('', [fieldCompletions(fields)], 200).map((item) => item.label);

    expect(labels.slice(0, 2)).toEqual(['definitions', 'name']);
    expect(labels[2]).toBe('definitions.1000.enumFlags');
    expect(labels).toHaveLength(200);
  });
});

describe('fieldCompletions in an object key', () => {
  it('quotes a dotted field name so the key is valid', () => {
    const [field] = fieldCompletions(
      [{ path: 'address.city', types: ['string'], presence: 1 }],
      true,
    );
    expect(field?.label).toBe('address.city');
    expect(field?.insertText).toBe('"address.city"');
  });

  it('leaves a bare field name unquoted', () => {
    const [field] = fieldCompletions([{ path: 'status', types: ['string'], presence: 1 }], true);
    expect(field?.insertText).toBeUndefined();
  });
});

describe('mergeCompletions', () => {
  const sources = [
    runtimeCompletions(
      [
        { text: 'db.orders.find', kind: 'method' },
        { text: 'db.orders.findOne', kind: 'method' },
      ],
      'db.orders.',
    ),
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
      runtimeCompletions([{ text: 'status', kind: 'property' }], ''),
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

describe('completionContext across lines and positions', () => {
  const query = `db.events.find({createdAt:{$gt: ISODate("2025-10-10T10:51:30.232Z") }}).sort({
  createdAt: 1
}).li`;

  it('folds a statement that spans lines, so a chained method keeps its collection', () => {
    const context = completionContext(query, query.length);
    expect(context.prefix).toBe('li');
    expect(context.collection).toBe('events');
    expect(context.head).toContain('db.events.find(');
    expect(context.head).not.toContain('\n');
    expect(context.cursorMember).toBe(true);
  });

  it('offers the cursor methods after a find chain and nothing after a plain call', () => {
    const labels = staticCompletionsFor(completionContext(query, query.length)).map(
      (item) => item.label,
    );
    expect(labels).toEqual(expect.arrayContaining(['limit', 'sort', 'skip', 'toArray']));

    const plain = 'db.events.countDocuments().';
    expect(staticCompletionsFor(completionContext(plain, plain.length))).toEqual([]);
  });

  it('offers the BSON constructors where a value starts, as snippets', () => {
    const code = 'db.events.find({ createdAt: { $gt: ';
    const items = staticCompletionsFor(completionContext(code, code.length));
    const iso = items.find((item) => item.label === 'ISODate');
    expect(iso).toMatchObject({ snippet: true, insertText: 'ISODate("$1")', kind: 'method' });
    expect(items.map((item) => item.label)).toEqual(
      expect.arrayContaining(['ObjectId', 'Long', 'Decimal128', 'UUID']),
    );
  });

  it('offers no constructors where a key starts', () => {
    const code = 'db.events.find({ ';
    expect(staticCompletionsFor(completionContext(code, code.length))).toEqual([]);
  });

  it('reads a dotted parent and a quoted key', () => {
    const dotted = 'db.events.find({ customer.na';
    expect(completionContext(dotted, dotted.length)).toMatchObject({
      prefix: 'na',
      fieldParent: 'customer',
      objectKey: true,
      quotedKey: false,
    });
    const quoted = 'db.events.find({ "cust';
    expect(completionContext(quoted, quoted.length)).toMatchObject({
      prefix: 'cust',
      objectKey: true,
      quotedKey: true,
    });
  });

  it('sees an object key on a continuation line', () => {
    const code = 'db.events.find({\n  crea';
    expect(completionContext(code, code.length)).toMatchObject({
      prefix: 'crea',
      objectKey: true,
      collection: 'events',
    });
  });
});

describe('fieldCompletions with a dotted parent and quoted keys', () => {
  const fields = [
    { path: 'customer', types: ['object'], presence: 1 },
    { path: 'customer.name', types: ['string'], presence: 1 },
    { path: 'customer.address.city', types: ['string'], presence: 1 },
    { path: 'status', types: ['string'], presence: 1 },
  ];

  it('lists the children of the typed parent without the parent prefix', () => {
    const labels = fieldCompletions(fields, true, { parent: 'customer' }).map((item) => item.label);
    expect(labels).toEqual(['name', 'address.city']);
  });

  it('adds no quotes inside an already quoted key', () => {
    const [item] = fieldCompletions(
      [{ path: 'customer.name', types: ['string'], presence: 1 }],
      true,
      { quoted: true },
    );
    expect(item?.insertText).toBeUndefined();
  });
});
