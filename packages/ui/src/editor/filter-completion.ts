import type { SchemaField } from '@mongo-gui/core';
import { fieldCompletions, mergeCompletions, type EditorCompletion } from './completion-model';
import { QUERY_OPERATORS } from './operators';

/** The operators a filter offers first, most used first. The other query operators follow in table order. */
const COMMON_OPERATORS: readonly string[] = [
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

/**
 * The Extended JSON forms offered where a value starts. The keys are double-quoted, and `$` is
 * escaped in the snippet, so the cursor lands inside the first value.
 */
const EJSON_FORMS: readonly EditorCompletion[] = [
  {
    label: '$oid',
    kind: 'method',
    detail: '{"$oid": ""}',
    doc: 'ObjectId in Extended JSON. The string is 24 hex characters.',
    rank: 1,
    insertText: '{"\\$oid": "$1"}',
    snippet: true,
  },
  {
    label: '$date',
    kind: 'method',
    detail: '{"$date": ""}',
    doc: 'Date in Extended JSON. The string is an ISO 8601 date.',
    rank: 1,
    insertText: '{"\\$date": "$1"}',
    snippet: true,
  },
  {
    label: '$numberLong',
    kind: 'method',
    detail: '{"$numberLong": ""}',
    doc: '64-bit integer in Extended JSON. The string holds the digits.',
    rank: 1,
    insertText: '{"\\$numberLong": "$1"}',
    snippet: true,
  },
  {
    label: '$regularExpression',
    kind: 'method',
    detail: '{"$regularExpression": {"pattern": "", "options": ""}}',
    doc: 'Regular expression in Extended JSON.',
    rank: 1,
    insertText: '{"\\$regularExpression": {"pattern": "$1", "options": ""}}',
    snippet: true,
  },
];

interface FilterCompletions {
  /** Characters before the cursor that the completion replaces: the typed key or value. */
  readonly replaceLength: number;
  readonly items: readonly EditorCompletion[];
}

interface Frame {
  /** The bracket that opened the object or array. */
  readonly open: '{' | '[';
  /** The key that holds the object or array, or undefined for a root, an array element or a `$` key. */
  readonly segment: string | undefined;
}

interface OpenString {
  /** Index of the opening quote. */
  readonly start: number;
  /** True when the string is an object key, not a value. */
  readonly key: boolean;
}

interface Scan {
  readonly frames: readonly Frame[];
  /** The last character outside strings. A closed string counts as a quote. */
  readonly last: string;
  /** Set when the text ends inside a string. */
  readonly open: OpenString | undefined;
}

const NOTHING: FilterCompletions = { replaceLength: 0, items: [] };
const BARE_TOKEN = /[\w$.]*$/;

/**
 * Completions for the filter text before the cursor. A key offers the sampled fields of the object
 * it sits in and the query operators. A value offers the Extended JSON forms. The fields are the
 * sample of the editor's collection, and an empty list leaves the operators.
 *
 * Keys are double-quoted. A key typed inside its quotes gets the bare name, so the closing quote
 * stays where it is.
 */
export function filterCompletions(head: string, fields: readonly SchemaField[]): FilterCompletions {
  const whole = scan(head);
  if (whole.open !== undefined) {
    if (!whole.open.key) {
      return NOTHING;
    }
    return {
      replaceLength: head.length - whole.open.start - 1,
      items: keyItems(whole.frames, fields, true),
    };
  }
  const bare = BARE_TOKEN.exec(head)?.[0] ?? '';
  const before = scan(head.slice(0, head.length - bare.length));
  const top = topOf(before.frames);
  if (top?.open === '{' && (before.last === '{' || before.last === ',')) {
    return { replaceLength: bare.length, items: keyItems(before.frames, fields, false) };
  }
  if (before.last === ':' || (top?.open === '[' && (before.last === '[' || before.last === ','))) {
    return { replaceLength: bare.length, items: valueItems() };
  }
  return NOTHING;
}

/** Walks the text once and reports the open objects and arrays, the last character and any open string. */
function scan(text: string): Scan {
  const frames: Frame[] = [];
  let last = '';
  // The key string that closed last, and the key whose value starts after the next colon.
  let candidate: string | undefined;
  let key: string | undefined;
  let open: OpenString | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (open !== undefined) {
      if (char === '\\') {
        index += 1;
      } else if (char === '"') {
        candidate = open.key ? text.slice(open.start + 1, index) : undefined;
        open = undefined;
        last = '"';
      }
      continue;
    }
    if (char === '"') {
      const top = topOf(frames);
      open = { start: index, key: top?.open === '{' && (last === '{' || last === ',') };
    } else if (char === '{' || char === '[') {
      frames.push({ open: char, segment: last === ':' ? segmentOf(key) : undefined });
      last = char;
    } else if (char === '}' || char === ']') {
      frames.pop();
      last = char;
    } else if (char === ':') {
      key = candidate;
      last = ':';
    } else if (!/\s/.test(char)) {
      last = char;
    }
  }
  return { frames, last, open };
}

function topOf(frames: readonly Frame[]): Frame | undefined {
  return frames[frames.length - 1];
}

/** A `$` key names an operator, not a field, so it does not extend the dotted path. */
function segmentOf(key: string | undefined): string | undefined {
  return key === undefined || key.startsWith('$') ? undefined : key;
}

/**
 * The fields under the object the cursor sits in, relative to that object, then the operators.
 * Array elements count as `path[]` in the sample, and a filter names them by the plain path.
 */
function keyItems(
  frames: readonly Frame[],
  fields: readonly SchemaField[],
  inString: boolean,
): EditorCompletion[] {
  const parent = frames
    .map((frame) => frame.segment)
    .filter((segment): segment is string => segment !== undefined)
    .join('.');
  const plain = fields.map((field) => ({ ...field, path: field.path.replaceAll('[]', '') }));
  const names = [
    ...fieldCompletions(plain, false, { parent: parent === '' ? undefined : parent }),
    ...filterOperatorCompletions(),
  ];
  return mergeCompletions('', [names]).map((item) => ({
    ...item,
    insertText: inString ? item.label : JSON.stringify(item.label),
  }));
}

/**
 * The query operators, ranked by COMMON_OPERATORS. Update, pipeline and expression operators are not
 * valid in a filter, so they are not offered. The rank is the position in the list.
 */
function filterOperatorCompletions(): EditorCompletion[] {
  return QUERY_OPERATORS.map((operator, index): EditorCompletion => {
    const common = COMMON_OPERATORS.indexOf(operator.name);
    return {
      label: operator.name,
      kind: 'operator',
      doc: operator.doc,
      rank: common === -1 ? COMMON_OPERATORS.length + index : common,
    };
  });
}

function valueItems(): EditorCompletion[] {
  return mergeCompletions('', [EJSON_FORMS]);
}
