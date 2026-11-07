/**
 * Reads the projection, sort and stage parts of a find or aggregate statement into the model. It is
 * the inverse of `projectionToEjson`, `sortToEjson` and `stageToEjson` in `emit.ts`. Anything the
 * model cannot show becomes a raw row or a raw stage, so the emitter writes it back unchanged. A
 * sort value other than `1` or `-1` has no raw form, so `sortFromEjson` returns null for it.
 */

import {
  ACCUMULATORS,
  type AccumulatorRow,
  type PipelineStage,
  type ProjectionRow,
  type SortRow,
  type StageBody,
} from './model';
import { filterFromEjson, isPlainObject } from './parse-filter';

type Plain = Record<string, unknown>;

/** One row per field. `1` or `true` includes the field, `0` or `false` excludes it. */
export function projectionFromEjson(projection: Plain): ProjectionRow[] {
  return Object.entries(projection).map(([field, value]): ProjectionRow => {
    if (value === 1 || value === true) {
      return { kind: 'field', enabled: true, field, include: true };
    }
    if (value === 0 || value === false) {
      return { kind: 'field', enabled: true, field, include: false };
    }
    return { kind: 'raw', enabled: true, field, value };
  });
}

/** One row per field, in key order. Returns null when a direction is not `1` or `-1`. */
export function sortFromEjson(sort: Plain): SortRow[] | null {
  const rows: SortRow[] = [];
  for (const [field, direction] of Object.entries(sort)) {
    if (direction !== 1 && direction !== -1) {
      return null;
    }
    rows.push({ enabled: true, field, direction });
  }
  return rows;
}

/**
 * Reads one stage document such as `{ $match: { ... } }`. Returns null when the document does not
 * hold exactly one key. A stage the model cannot show becomes a raw stage.
 */
export function stageFromEjson(stage: Plain): PipelineStage | null {
  const entries = Object.entries(stage);
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined) {
    return null;
  }
  const [name, value] = entry;
  return { ...stageBodyOf(name, value), enabled: true };
}

function stageBodyOf(name: string, value: unknown): StageBody {
  return knownStageOf(name, value) ?? { stage: 'raw', name, value };
}

/** The body of a stage the model has a form for, or undefined when the value does not fit it. */
function knownStageOf(name: string, value: unknown): StageBody | undefined {
  switch (name) {
    case '$match':
      return isPlainObject(value) ? { stage: '$match', filter: filterFromEjson(value) } : undefined;
    case '$project':
      return isPlainObject(value)
        ? { stage: '$project', rows: projectionFromEjson(value) }
        : undefined;
    case '$sort': {
      const rows = isPlainObject(value) ? sortFromEjson(value) : null;
      return rows === null ? undefined : { stage: '$sort', rows };
    }
    case '$limit':
    case '$skip':
      return typeof value === 'number' ? { stage: name, count: value } : undefined;
    case '$count':
      return typeof value === 'string' ? { stage: '$count', output: value } : undefined;
    case '$unwind':
      return unwindOf(value);
    case '$group':
      return groupOf(value);
    case '$lookup':
      return lookupOf(value);
    default:
      return undefined;
  }
}

/** `{ $unwind: "$path" }` or `{ $unwind: { path: "$path", preserveNullAndEmptyArrays: bool } }`. */
function unwindOf(value: unknown): StageBody | undefined {
  if (typeof value === 'string') {
    return unwindStage(value, false);
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  const { path, preserveNullAndEmptyArrays: preserve } = value;
  const onlyKnownKeys = Object.keys(value).every(
    (key) => key === 'path' || key === 'preserveNullAndEmptyArrays',
  );
  if (!onlyKnownKeys || (preserve !== undefined && typeof preserve !== 'boolean')) {
    return undefined;
  }
  return typeof path === 'string' ? unwindStage(path, preserve === true) : undefined;
}

/** The model keeps the path without its `$` prefix. A path without the prefix is raw. */
function unwindStage(path: string, preserveEmpty: boolean): StageBody | undefined {
  if (!path.startsWith('$') || path.length < 2) {
    return undefined;
  }
  return { stage: '$unwind', path: path.slice(1), preserveEmpty };
}

/** `{ _id: expr, out: { $sum: expr }, ... }`. An accumulator outside the model makes the stage raw. */
function groupOf(value: unknown): StageBody | undefined {
  if (!isPlainObject(value) || !('_id' in value)) {
    return undefined;
  }
  const accumulators: AccumulatorRow[] = [];
  for (const [output, spec] of Object.entries(value)) {
    if (output === '_id') {
      continue;
    }
    const row = accumulatorRowOf(output, spec);
    if (row === undefined) {
      return undefined;
    }
    accumulators.push(row);
  }
  return { stage: '$group', id: value._id, accumulators };
}

function accumulatorRowOf(output: string, spec: unknown): AccumulatorRow | undefined {
  if (!isPlainObject(spec)) {
    return undefined;
  }
  const entries = Object.entries(spec);
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined) {
    return undefined;
  }
  const [name, expression] = entry;
  const accumulator = ACCUMULATORS.find((known) => known === name);
  return accumulator === undefined ? undefined : { output, accumulator, expression };
}

/** A `$lookup` with exactly the four fields of the form. A `pipeline` or `let` key makes it raw. */
function lookupOf(value: unknown): StageBody | undefined {
  if (!isPlainObject(value) || Object.keys(value).length !== 4) {
    return undefined;
  }
  const { from, localField, foreignField, as: alias } = value;
  if (
    typeof from !== 'string' ||
    typeof localField !== 'string' ||
    typeof foreignField !== 'string' ||
    typeof alias !== 'string'
  ) {
    return undefined;
  }
  return { stage: '$lookup', from, localField, foreignField, as: alias };
}
