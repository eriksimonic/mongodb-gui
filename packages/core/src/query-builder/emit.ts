/**
 * Turns a statement of the query builder into mongosh text: `db.<name>.find(...)` with its chain,
 * or `db.<name>.aggregate([...])`. Disabled parts and stages are left out. The helpers that turn one
 * part into canonical EJSON are exported, so the parser can invert them.
 */

import { formatMongoshSyntax } from '../ejson/format';
import { collectionAccess } from '../shell/collection-access';
import { emitFilter, filterToEjson } from './emit-filter';
import type {
  FindStatement,
  PipelineStage,
  ProjectionRow,
  QueryStatement,
  SortRow,
  StageBody,
} from './model';

type Plain = Record<string, unknown>;

// Known limit: a field named like an integer, such as "2", moves first in sort and projection.
/** The projection as canonical EJSON: `1` or `0` for a field row, the value for a raw row. */
export function projectionToEjson(rows: readonly ProjectionRow[]): Plain {
  const pairs: [string, unknown][] = rows
    .filter((row) => row.enabled)
    .map((row) => [row.field, row.kind === 'field' ? (row.include ? 1 : 0) : row.value]);
  return Object.fromEntries(pairs);
}

/** The sort as canonical EJSON, `{ field: 1 }` or `{ field: -1 }`. */
export function sortToEjson(rows: readonly SortRow[]): Plain {
  const pairs: [string, number][] = rows
    .filter((row) => row.enabled)
    .map((row) => [row.field, row.direction]);
  return Object.fromEntries(pairs);
}

/** One aggregation stage as canonical EJSON, such as `{ $match: { ... } }`. */
export function stageToEjson(stage: StageBody): Plain {
  switch (stage.stage) {
    case '$match':
      return { $match: filterToEjson(stage.filter) };
    case '$project':
      return { $project: projectionToEjson(stage.rows) };
    case '$sort':
      return { $sort: sortToEjson(stage.rows) };
    case '$limit':
    case '$skip':
      return { [stage.stage]: stage.count };
    case '$count':
      return { $count: stage.output };
    case '$unwind':
      return {
        $unwind: stage.preserveEmpty
          ? { path: `$${stage.path}`, preserveNullAndEmptyArrays: true }
          : `$${stage.path}`,
      };
    case '$group': {
      const pairs: [string, unknown][] = [
        ['_id', stage.id],
        ...stage.accumulators.map((row): [string, unknown] => [
          row.output,
          { [row.accumulator]: row.expression },
        ]),
      ];
      return { $group: Object.fromEntries(pairs) };
    }
    case '$lookup':
      return {
        $lookup: {
          from: stage.from,
          localField: stage.localField,
          foreignField: stage.foreignField,
          as: stage.as,
        },
      };
    case 'raw':
      return { [stage.name]: stage.value };
  }
}

/** The statement as mongosh text, indented two spaces. */
export function emitStatement(statement: QueryStatement): string {
  const access = collectionAccess(statement.collection);
  return statement.kind === 'aggregate'
    ? aggregateText(access, statement.stages)
    : findText(access, statement);
}

function aggregateText(access: string, stages: readonly PipelineStage[]): string {
  const pipeline = stages
    .filter((stage) => stage.enabled && !hasNoLiveRows(stage))
    .map((stage) => stageToEjson(stage));
  return `${access}.aggregate(${mongoshText(pipeline)})`;
}

/** True for a `$project` or `$sort` with no enabled row. MongoDB rejects it, so it is dropped. */
function hasNoLiveRows(stage: StageBody): boolean {
  if (stage.stage !== '$project' && stage.stage !== '$sort') {
    return false;
  }
  const rows: readonly { readonly enabled: boolean }[] = stage.rows;
  return rows.every((row) => !row.enabled);
}

function findText(access: string, statement: FindStatement): string {
  const filter = filterToEjson(statement.filter);
  const projection = projectionToEjson(statement.projection);
  const sort = sortToEjson(statement.sort);

  // An empty filter is left out unless a projection follows it.
  const args = hasKeys(projection)
    ? [emitFilter(statement.filter), mongoshText(projection)]
    : hasKeys(filter)
      ? [emitFilter(statement.filter)]
      : [];

  let text = `${access}.find(${args.join(', ')})`;
  if (hasKeys(sort)) {
    text += `.sort(${mongoshText(sort)})`;
  }
  if (statement.skip !== null) {
    text += `.skip(${statement.skip})`;
  }
  if (statement.limit !== null) {
    text += `.limit(${statement.limit})`;
  }
  return text;
}

function hasKeys(value: Plain): boolean {
  return Object.keys(value).length > 0;
}

function mongoshText(value: unknown): string {
  return formatMongoshSyntax(JSON.stringify(value), { indent: 2 });
}
