// Measure a $lookup inner pipeline. The server reports no plan for the stages inside a $lookup,
// so the app takes one document that reaches the $lookup, binds its `let` values into the inner
// pipeline, and explains that pipeline on its own against the joined collection.

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

/** The aggregate the explain ran, from the command the server echoes in its output (6.0 on). */
export interface EchoedAggregate {
  readonly collection: string;
  readonly pipeline: readonly unknown[];
}

/** The echoed aggregate of an explain, or undefined when the output has none. */
export function echoedAggregate(rawEjson: string): EchoedAggregate | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(rawEjson);
  } catch {
    return undefined;
  }
  const command = asObject(asObject(raw)?.['command']);
  const collection = command?.['aggregate'];
  const pipeline = command?.['pipeline'];
  return typeof collection === 'string' && Array.isArray(pipeline)
    ? { collection, pipeline }
    : undefined;
}

/** What a $lookup joins, read from its spec. */
export interface LookupSpec {
  readonly from: string;
  readonly as: string;
  readonly localField?: string;
  readonly foreignField?: string;
  readonly let?: Json;
  readonly pipeline?: readonly unknown[];
}

/** The spec of a $lookup stage from its raw explain node, or undefined for other stages. */
export function lookupSpec(raw: unknown): LookupSpec | undefined {
  const spec = asObject(asObject(raw)?.['$lookup']);
  const from = spec?.['from'];
  const as = spec?.['as'];
  if (spec === undefined || typeof from !== 'string' || typeof as !== 'string') {
    return undefined;
  }
  const localField = spec['localField'];
  const foreignField = spec['foreignField'];
  const letVars = asObject(spec['let']);
  const pipeline = spec['pipeline'];
  return {
    from,
    as,
    ...(typeof localField === 'string' ? { localField } : {}),
    ...(typeof foreignField === 'string' ? { foreignField } : {}),
    ...(letVars === undefined ? {} : { let: letVars }),
    ...(Array.isArray(pipeline) ? { pipeline } : {}),
  };
}

/** Where the $lookup sits in the echoed pipeline: the first top-level $lookup with its from and as. */
export function lookupPosition(pipeline: readonly unknown[], spec: LookupSpec): number {
  return pipeline.findIndex((stage) => {
    const candidate = lookupSpec(stage);
    return candidate?.from === spec.from && candidate.as === spec.as;
  });
}

/**
 * The mongosh code that runs the stages before the $lookup, takes the first document, and
 * evaluates the `let` expressions and the local field on it. It returns the values as canonical
 * EJSON text, or null when no document reaches the $lookup.
 */
export function sampleCode(
  collection: string,
  before: readonly unknown[],
  spec: LookupSpec,
): string {
  const shape: Json = {};
  if (spec.let !== undefined && Object.keys(spec.let).length > 0) {
    shape['vars'] = spec.let;
  }
  if (spec.localField !== undefined) {
    // An array wrapper keeps a missing field as null instead of dropping the key.
    shape['local'] = [`$${spec.localField}`];
  }
  const stages = [...before, { $limit: 1 }, { $replaceWith: { $mergeObjects: [{}, shape] } }];
  // One expression, so the shell returns its value as the result.
  return [
    '(() => {',
    `  const docs = db.getCollection(${JSON.stringify(collection)})`,
    `    .aggregate(EJSON.parse(${JSON.stringify(JSON.stringify(stages))}, { relaxed: false }))`,
    '    .toArray();',
    '  return docs.length === 0 ? null : EJSON.stringify(docs[0], { relaxed: false });',
    '})()',
  ].join('\n');
}

/** The values a sample document gave the $lookup. */
export interface LookupSample {
  readonly vars: Json;
  /** The local field's value, set when the $lookup has a localField. */
  readonly local?: unknown;
}

/**
 * Reads the shell result of sampleCode. Undefined when no document reached the $lookup. The
 * result is the EJSON text of a string, so it is parsed twice.
 */
export function parseSample(printableEjson: string): LookupSample | undefined {
  const text: unknown = JSON.parse(printableEjson);
  if (typeof text !== 'string') {
    return undefined;
  }
  const document = asObject(JSON.parse(text)) ?? {};
  const local = document['local'];
  return {
    vars: asObject(document['vars']) ?? {},
    ...(Array.isArray(local) ? { local: local[0] ?? null } : {}),
  };
}

const VARIABLE = /^\$\$([A-Za-z_][\w]*)((?:\.[^.]+)*)$/;

function pathValue(value: unknown, path: readonly string[]): unknown {
  if (path.length === 0) {
    return value;
  }
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    return value.map((item) => pathValue(item, path));
  }
  const next = asObject(value)?.[head ?? ''];
  return next === undefined ? null : pathValue(next, rest);
}

/**
 * Replaces each `$$name` and `$$name.path` of the sample's variables with the value it had, as a
 * `$literal`. System variables such as `$$ROOT` and names the sample does not have stay as they are.
 */
export function bindVariables(value: unknown, vars: Json): unknown {
  if (typeof value === 'string') {
    const match = VARIABLE.exec(value);
    const name = match?.[1];
    if (match === null || name === undefined || !(name in vars)) {
      return value;
    }
    const path = (match[2] ?? '').split('.').filter((part) => part !== '');
    return { $literal: pathValue(vars[name], path) };
  }
  if (Array.isArray(value)) {
    return value.map((item) => bindVariables(item, vars));
  }
  const object = asObject(value);
  if (object === undefined) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [key, bindVariables(entry, vars)]),
  );
}

/**
 * The aggregate on the joined collection that does what the $lookup did for the sample document:
 * the equality match of localField and foreignField, then the inner pipeline with the `let`
 * values bound. Canonical EJSON text, ready for explain.runCommand.
 */
export function measuredCommand(spec: LookupSpec, sample: LookupSample): string {
  const stages: unknown[] = [];
  if (spec.localField !== undefined && spec.foreignField !== undefined) {
    const local = sample.local ?? null;
    stages.push({
      $match: { [spec.foreignField]: { $in: Array.isArray(local) ? local : [local] } },
    });
  }
  stages.push(...(spec.pipeline ?? []).map((stage) => bindVariables(stage, sample.vars)));
  return JSON.stringify({ aggregate: spec.from, pipeline: stages, cursor: {} });
}
