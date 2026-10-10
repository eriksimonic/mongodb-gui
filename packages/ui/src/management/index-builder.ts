import type { CreateIndexInput, IndexInfo, IndexKeyValue } from '@mongo-gui/core';
import { parseJsonObject } from './input-rules';

export const INDEX_ORDERS = ['1', '-1', 'text', '2dsphere', 'hashed', '2d'] as const;
export type IndexOrder = (typeof INDEX_ORDERS)[number];

export interface IndexFieldDraft {
  readonly field: string;
  readonly order: IndexOrder;
}

/** Everything the create index dialog holds. Numbers stay as typed until the builder reads them. */
export interface IndexDraft {
  readonly fields: readonly IndexFieldDraft[];
  readonly name: string;
  readonly unique: boolean;
  readonly sparse: boolean;
  readonly hidden: boolean;
  readonly ttlSeconds: string;
  readonly partialEjson: string;
  readonly collationEjson: string;
  readonly wildcardEjson: string;
  /** One `field: weight` pair per line. Used only when a text key exists. */
  readonly weights: string;
  readonly defaultLanguage: string;
  /**
   * Index options the dialog has no field for, as an EJSON object, such as storageEngine. Editing
   * an index fills it from the server, and the request passes it through unchanged.
   */
  readonly extraOptionsEjson: string;
}

export const EMPTY_INDEX_DRAFT: IndexDraft = {
  fields: [{ field: '', order: '1' }],
  name: '',
  unique: false,
  sparse: false,
  hidden: false,
  ttlSeconds: '',
  partialEjson: '',
  collationEjson: '',
  wildcardEjson: '',
  weights: '',
  defaultLanguage: '',
  extraOptionsEjson: '',
};

// The key entries MongoDB uses for a text index. The text fields are listed in its weights.
const TEXT_KEY = '_fts';
const TEXT_OPTIONS_KEY = '_ftsx';

export type IndexOptions = CreateIndexInput['options'];

/** The options that hold a JSON object as EJSON text. */
type DocumentOptionKey =
  'partialFilterExpressionEjson' | 'collationEjson' | 'wildcardProjectionEjson';

export type IndexRequest =
  | {
      readonly ok: true;
      readonly keys: Record<string, IndexKeyValue>;
      readonly options: IndexOptions;
    }
  | { readonly ok: false; readonly message: string };

const ORDER_VALUES: Readonly<Record<IndexOrder, IndexKeyValue>> = {
  '1': 1,
  '-1': -1,
  text: 'text',
  '2dsphere': '2dsphere',
  hashed: 'hashed',
  '2d': '2d',
};

export function keyValueOf(order: IndexOrder): IndexKeyValue {
  return ORDER_VALUES[order];
}

/** The name MongoDB gives an index without one: `field_direction` pairs joined by `_`. */
export function defaultNameFor(keys: Readonly<Record<string, IndexKeyValue>>): string {
  return Object.entries(keys)
    .map(([field, direction]) => `${field}_${String(direction)}`)
    .join('_');
}

/** The draft order for a key value the server reports, or undefined when the draft cannot hold it. */
export function orderOfKeyValue(value: number | string): IndexOrder | undefined {
  if (value === 1) {
    return '1';
  }
  if (value === -1) {
    return '-1';
  }
  return INDEX_ORDERS.find((order) => order === value);
}

/** True when the draft can hold the index, so Edit can rebuild its definition from the draft. */
export function canEditIndex(index: IndexInfo): boolean {
  return Object.entries(index.key).every(([field, value]) => {
    if (field === TEXT_OPTIONS_KEY) {
      return true;
    }
    if (field === TEXT_KEY) {
      return value === 'text' && Object.keys(index.weights ?? {}).length > 0;
    }
    return orderOfKeyValue(value) !== undefined;
  });
}

/**
 * The draft that rebuilds an index. It is the inverse of buildIndexRequest for the options the
 * draft holds. Call it only when canEditIndex is true.
 */
export function draftFromIndex(index: IndexInfo): IndexDraft {
  const fields: IndexFieldDraft[] = [];
  for (const [field, value] of Object.entries(index.key)) {
    if (field === TEXT_OPTIONS_KEY) {
      continue;
    }
    if (field === TEXT_KEY) {
      for (const textField of Object.keys(index.weights ?? {})) {
        fields.push({ field: textField, order: 'text' });
      }
      continue;
    }
    const order = orderOfKeyValue(value);
    if (order === undefined) {
      throw new Error(`The ${field} key of ${index.name} cannot be edited in the dialog`);
    }
    fields.push({ field, order });
  }
  return {
    fields,
    name: index.name,
    unique: index.unique === true,
    sparse: index.sparse === true,
    hidden: index.hidden === true,
    ttlSeconds: index.expireAfterSeconds === undefined ? '' : String(index.expireAfterSeconds),
    partialEjson: index.partialFilterExpressionEjson ?? '',
    collationEjson: index.collationEjson ?? '',
    wildcardEjson: index.wildcardProjectionEjson ?? '',
    weights: weightLines(index.weights),
    defaultLanguage: index.defaultLanguage ?? '',
    extraOptionsEjson: index.extraOptionsEjson ?? '',
  };
}

function weightLines(weights: Readonly<Record<string, number>> | undefined): string {
  return Object.entries(weights ?? {})
    .map(([field, weight]) => `${field}: ${weight}`)
    .join('\n');
}

export function hasTextKey(draft: IndexDraft): boolean {
  return draft.fields.some((item) => item.order === 'text');
}

/** Parses `field: weight` lines. Blank lines are skipped. Returns an error message on a bad line. */
export function parseWeights(text: string): Record<string, number> | string {
  const weights: Record<string, number> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') {
      continue;
    }
    const match = /^([^:\s]+)\s*:\s*(\d+(?:\.\d+)?)$/.exec(line);
    const field = match?.[1];
    const weight = match?.[2];
    if (field === undefined || weight === undefined) {
      return `Write each weight as "field: number", not "${line}"`;
    }
    weights[field] = Number(weight);
  }
  return weights;
}

/** Turns the dialog draft into the keys and options of a createIndex call. */
export function buildIndexRequest(draft: IndexDraft): IndexRequest {
  const fields = draft.fields
    .map((item) => ({ field: item.field.trim(), order: item.order }))
    .filter((item) => item.field !== '');
  if (fields.length === 0) {
    return { ok: false, message: 'Add at least one field' };
  }
  const names = fields.map((item) => item.field);
  if (new Set(names).size !== names.length) {
    return { ok: false, message: 'Each field can appear once in the key' };
  }
  const keys = Object.fromEntries(fields.map((item) => [item.field, keyValueOf(item.order)]));
  const options: IndexOptions = {};

  const name = draft.name.trim();
  if (name !== '') {
    options.name = name;
  }
  if (draft.unique) {
    options.unique = true;
  }
  if (draft.sparse) {
    options.sparse = true;
  }
  if (draft.hidden) {
    options.hidden = true;
  }

  const ttl = draft.ttlSeconds.trim();
  if (ttl !== '') {
    const seconds = Number(ttl);
    if (!Number.isInteger(seconds) || seconds < 0) {
      return { ok: false, message: 'The expiry must be a whole number of seconds, zero or more' };
    }
    if (fields.length > 1) {
      return { ok: false, message: 'TTL needs a single-field index' };
    }
    options.expireAfterSeconds = seconds;
  }

  const documentOptions: [DocumentOptionKey, string][] = [
    ['partialFilterExpressionEjson', draft.partialEjson],
    ['collationEjson', draft.collationEjson],
    ['wildcardProjectionEjson', draft.wildcardEjson],
  ];
  for (const [key, text] of documentOptions) {
    const trimmed = text.trim();
    if (trimmed === '') {
      continue;
    }
    const parsed = parseJsonObject(trimmed);
    if (!parsed.ok) {
      return { ok: false, message: `${documentLabel(key)}: ${parsed.message}` };
    }
    options[key] = trimmed;
  }

  const extra = draft.extraOptionsEjson.trim();
  if (extra !== '') {
    const parsed = parseJsonObject(extra);
    if (!parsed.ok) {
      return { ok: false, message: `The extra options: ${parsed.message}` };
    }
    options.extraOptionsEjson = extra;
  }

  if (hasTextKey(draft)) {
    const weights = parseWeights(draft.weights);
    if (typeof weights === 'string') {
      return { ok: false, message: weights };
    }
    if (Object.keys(weights).length > 0) {
      options.weights = weights;
    }
    const language = draft.defaultLanguage.trim();
    if (language !== '') {
      options.defaultLanguage = language;
    }
  }

  return { ok: true, keys, options };
}

function documentLabel(key: DocumentOptionKey): string {
  switch (key) {
    case 'partialFilterExpressionEjson':
      return 'The partial filter';
    case 'collationEjson':
      return 'The collation';
    case 'wildcardProjectionEjson':
      return 'The wildcard projection';
    default:
      return 'The option';
  }
}

/**
 * The createIndexes command the server runs for the draft, shown read-only in the dialog. Options
 * that hold EJSON appear as parsed objects, so the preview reads like the command itself.
 */
export function previewCommand(
  collection: string,
  request: Extract<IndexRequest, { ok: true }>,
): Record<string, unknown> {
  const { options } = request;
  const parsedExtra =
    options.extraOptionsEjson === undefined
      ? undefined
      : parseJsonObject(options.extraOptionsEjson);
  const spec: Record<string, unknown> = {
    ...(parsedExtra?.ok === true ? parsedExtra.value : {}),
    key: request.keys,
  };
  if (options.name !== undefined) {
    spec.name = options.name;
  }
  for (const flag of ['unique', 'sparse', 'hidden'] as const) {
    if (options[flag] !== undefined) {
      spec[flag] = options[flag];
    }
  }
  if (options.expireAfterSeconds !== undefined) {
    spec.expireAfterSeconds = options.expireAfterSeconds;
  }
  const embedded: [DocumentOptionKey, string][] = [
    ['partialFilterExpressionEjson', 'partialFilterExpression'],
    ['collationEjson', 'collation'],
    ['wildcardProjectionEjson', 'wildcardProjection'],
  ];
  for (const [source, target] of embedded) {
    const text = options[source];
    if (text !== undefined) {
      const parsed = parseJsonObject(text);
      spec[target] = parsed.ok ? parsed.value : text;
    }
  }
  if (options.weights !== undefined) {
    spec.weights = options.weights;
  }
  if (options.defaultLanguage !== undefined) {
    spec.default_language = options.defaultLanguage;
  }
  return { createIndexes: collection, indexes: [spec] };
}
