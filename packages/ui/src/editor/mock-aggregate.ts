// A small aggregation evaluator for the mock shell. It runs $match, $lookup, $unwind, $group,
// $project, $sort and $limit over the mock documents, so a query with a join or a GROUP BY shows
// a real result. A pipeline with any other stage returns undefined and the caller keeps the
// plain collection.

type Doc = Record<string, unknown>;

function isDoc(value: unknown): value is Doc {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a pipeline written in mongosh notation: single quotes and unquoted keys. */
export function parsePipeline(text: string): unknown[] | undefined {
  const json = text
    .replace(/'([^']*)'/g, (_, body: string) => JSON.stringify(body))
    .replace(/([{,]\s*)([$A-Za-z_][\w$]*)\s*:/g, '$1"$2":');
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function getPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) {
    if (!isDoc(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  const a = typeof left === 'string' ? left : JSON.stringify(left);
  const b = typeof right === 'string' ? right : JSON.stringify(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function matches(document: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([field, condition]) => {
    const value = getPath(document, field);
    if (!isDoc(condition)) {
      return same(value, condition);
    }
    return Object.entries(condition).every(([operator, operand]) => {
      switch (operator) {
        case '$gt':
          return compare(value, operand) > 0;
        case '$gte':
          return compare(value, operand) >= 0;
        case '$lt':
          return compare(value, operand) < 0;
        case '$lte':
          return compare(value, operand) <= 0;
        case '$ne':
          return !same(value, operand);
        case '$in':
          return Array.isArray(operand) && operand.some((item) => same(item, value));
        default:
          throw new Error(`Unsupported operator ${operator}`);
      }
    });
  });
}

/** A field path such as "$c.country", or a literal when the text has no leading dollar. */
function evaluate(document: Doc, expression: unknown): unknown {
  return typeof expression === 'string' && expression.startsWith('$')
    ? getPath(document, expression.slice(1))
    : expression;
}

function accumulate(documents: readonly Doc[], spec: unknown): unknown {
  if (!isDoc(spec)) {
    throw new Error('Unsupported accumulator');
  }
  const [operator, operand] = Object.entries(spec)[0] ?? [];
  const values = documents.map((document) => evaluate(document, operand));
  const numbers = values.filter((value): value is number => typeof value === 'number');
  switch (operator) {
    case '$sum':
      return numbers.reduce((total, value) => total + value, 0);
    case '$avg':
      return numbers.length === 0
        ? null
        : numbers.reduce((total, value) => total + value, 0) / numbers.length;
    case '$min':
      return values.reduce((low, value) => (compare(value, low) < 0 ? value : low));
    case '$max':
      return values.reduce((high, value) => (compare(value, high) > 0 ? value : high));
    case '$first':
      return values[0];
    default:
      throw new Error(`Unsupported accumulator ${String(operator)}`);
  }
}

function group(documents: readonly Doc[], spec: Doc): Doc[] {
  const buckets = new Map<string, { id: unknown; documents: Doc[] }>();
  for (const document of documents) {
    const id = evaluate(document, spec['_id']);
    const key = JSON.stringify(id) ?? 'undefined';
    const bucket = buckets.get(key) ?? { id, documents: [] };
    bucket.documents.push(document);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map((bucket) => ({
    _id: bucket.id,
    ...Object.fromEntries(
      Object.entries(spec)
        .filter(([field]) => field !== '_id')
        .map(([field, accumulator]) => [field, accumulate(bucket.documents, accumulator)]),
    ),
  }));
}

function unwind(documents: readonly Doc[], spec: unknown): Doc[] {
  const path = typeof spec === 'string' ? spec : isDoc(spec) ? spec['path'] : undefined;
  if (typeof path !== 'string' || !path.startsWith('$')) {
    throw new Error('Unsupported $unwind');
  }
  const keepEmpty = isDoc(spec) && spec['preserveNullAndEmptyArrays'] === true;
  const field = path.slice(1);
  return documents.flatMap((document) => {
    const value = document[field];
    if (Array.isArray(value) && value.length > 0) {
      return value.map((item) => ({ ...document, [field]: item }));
    }
    return keepEmpty ? [document] : [];
  });
}

function project(documents: readonly Doc[], spec: Doc): Doc[] {
  return documents.map((document) => {
    const out: Doc = {};
    if (!('_id' in spec)) {
      out['_id'] = document['_id'];
    }
    for (const [field, rule] of Object.entries(spec)) {
      if (rule === 0 || rule === false) {
        continue;
      }
      out[field] = rule === 1 || rule === true ? document[field] : evaluate(document, rule);
    }
    return out;
  });
}

function sort(documents: readonly Doc[], spec: Doc): Doc[] {
  return documents.slice().sort((left, right) => {
    for (const [field, direction] of Object.entries(spec)) {
      const order = compare(getPath(left, field), getPath(right, field));
      if (order !== 0) {
        return direction === -1 ? -order : order;
      }
    }
    return 0;
  });
}

/**
 * Runs the pipeline over the documents. `collection` returns the documents of another collection
 * for $lookup. Undefined when a stage is not supported.
 */
export function runPipeline(
  pipeline: readonly unknown[],
  documents: readonly Doc[],
  collection: (name: string) => readonly Doc[],
): Doc[] | undefined {
  try {
    let current = documents.slice();
    for (const stage of pipeline) {
      const [name, spec] = isDoc(stage) ? (Object.entries(stage)[0] ?? []) : [];
      switch (name) {
        case '$match':
          current = current.filter((document) => matches(document, spec as Doc));
          break;
        case '$lookup': {
          const { from, localField, foreignField, as } = spec as Record<string, string>;
          const foreign = collection(from ?? '');
          current = current.map((document) => ({
            ...document,
            [as ?? '']: foreign.filter((other) =>
              same(getPath(other, foreignField ?? ''), getPath(document, localField ?? '')),
            ),
          }));
          break;
        }
        case '$unwind':
          current = unwind(current, spec);
          break;
        case '$group':
          current = group(current, spec as Doc);
          break;
        case '$project':
          current = project(current, spec as Doc);
          break;
        case '$sort':
          current = sort(current, spec as Doc);
          break;
        case '$limit':
          current = current.slice(0, spec as number);
          break;
        default:
          return undefined;
      }
    }
    return current;
  } catch {
    return undefined;
  }
}
