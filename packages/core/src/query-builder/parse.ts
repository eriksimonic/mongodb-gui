/**
 * Reads mongosh text into the query builder model. It takes a statement under the cursor, a bare
 * filter object for the copy dialog, or one value for a raw text box. It accepts the forms that
 * `emit.ts` writes: `db.<name>.find(filter?, projection?)` with `.sort()`, `.skip()` and `.limit()`
 * in any order, `db.<name>.aggregate([...])`, and an object literal. Any other text is unsupported,
 * and the caller leaves it unchanged.
 */

import {
  type Comment,
  type Expression,
  type MemberExpression,
  type SpreadElement,
  type Super,
  parseExpressionAt,
} from 'acorn';
import {
  type AggregateStatement,
  type FindStatement,
  type PipelineStage,
  type QueryGroup,
  type QueryStatement,
  type SortRow,
} from './model';
import { type EjsonValue, parseLiteral } from './literal';
import { filterFromEjson, isPlainObject } from './parse-filter';
import { projectionFromEjson, sortFromEjson, stageFromEjson } from './parse-parts';

type Plain = Record<string, unknown>;
type Argument = Expression | SpreadElement | null | undefined;
type Outcome<T> = { readonly value: T } | { readonly unsupported: string };

/** A span of the text, `end` exclusive. The same convention as `Span` in `sql/ast.ts`. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

export type ParsedStatement =
  | { readonly range: TextRange; readonly statement: QueryStatement }
  | { readonly range: TextRange; readonly unsupported: string };

export type ParsedFilter = { readonly filter: QueryGroup } | { readonly unsupported: string };

/** One call after `find`, such as `.sort({ ... })`. */
interface ChainCall {
  readonly method: string;
  readonly args: readonly Argument[];
}

interface ChainParts {
  readonly sort: SortRow[];
  readonly skip: number | null;
  readonly limit: number | null;
}

const CHAIN_METHODS: ReadonlySet<string> = new Set(['sort', 'skip', 'limit']);

/**
 * The statement that contains `offset`. The text is read one statement at a time, so a broken or
 * mongosh-only line such as `use shop` does not hide the statements around it. A statement the
 * builder cannot read returns `unsupported` with its range. Returns null when the offset is in
 * whitespace, a comment or a semicolon between statements, or when no statement follows it.
 *
 * Known limit: a syntax error cannot be split from the text after it. Its range runs from the
 * start of the broken statement to the end of the text, so every offset in that range is
 * unsupported.
 */
export function parseStatementAt(text: string, offset: number): ParsedStatement | null {
  let pos = skipGap(text, 0);
  while (pos < text.length) {
    const comments: Comment[] = [];
    let node: Expression;
    try {
      node = parseExpressionAt(text, pos, { ecmaVersion: 'latest', onComment: comments });
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return offset < pos
        ? null
        : {
            range: { start: pos, end: text.length },
            unsupported: `syntax error: ${error.message}`,
          };
    }
    if (offset < node.start) return null;
    const range = { start: node.start, end: semicolonEnd(text, node.end) };
    if (offset <= range.end) return statementAt(node, range, comments);
    pos = skipGap(text, range.end);
  }
  return null;
}

/**
 * The filter object of the copy dialog. Returns null for an empty text. Otherwise the text must be
 * one object literal, with no comment and nothing after it except an optional `;`.
 */
export function parseFilterText(text: string): ParsedFilter | null {
  if (text.trim() === '') return null;
  const comments: Comment[] = [];
  let node: Expression;
  try {
    node = parseExpressionAt(text, 0, { ecmaVersion: 'latest', onComment: comments });
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return refuse(`syntax error: ${error.message}`);
  }
  if (comments.length > 0) return refuse('comment in the filter');
  if (!/^\s*;?\s*$/.test(text.slice(node.end))) return refuse('text after the filter');
  const object = objectOf(node);
  return 'unsupported' in object ? object : { filter: filterFromEjson(object.value) };
}

/**
 * One value for a raw text box, such as `{ $slice: 5 }`, `[1, 2]`, `/a/i` or `ObjectId("...")`.
 * The whole text is one expression. A comment, text after the value or an empty text is unsupported.
 */
export function parseValueText(
  text: string,
): { readonly value: EjsonValue } | { readonly unsupported: string } {
  if (text.trim() === '') return refuse('empty text');
  const comments: Comment[] = [];
  let node: Expression;
  try {
    node = parseExpressionAt(text, 0, { ecmaVersion: 'latest', onComment: comments });
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return refuse(`syntax error: ${error.message}`);
  }
  if (comments.length > 0) return refuse('comment in the value');
  if (text.slice(node.end).trim() !== '') return refuse('text after the value');
  return parseLiteral(node);
}

function refuse(reason: string): { readonly unsupported: string } {
  return { unsupported: reason };
}

function statementAt(
  node: Expression,
  range: TextRange,
  comments: readonly Comment[],
): ParsedStatement {
  if (comments.some((comment) => comment.start >= range.start && comment.end <= range.end)) {
    return { range, unsupported: 'comment in the statement' };
  }
  const outcome = statementOf(node);
  return 'unsupported' in outcome
    ? { range, unsupported: outcome.unsupported }
    : { range, statement: outcome.value };
}

/** The index after whitespace, semicolons and comments, starting at `from`. */
function skipGap(text: string, from: number): number {
  const gap = /(?:\s|;|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/y;
  gap.lastIndex = from;
  gap.exec(text);
  return gap.lastIndex;
}

/** The index after a `;` that follows `at` on the same line, or `at` when there is none. */
function semicolonEnd(text: string, at: number): number {
  const semicolon = /[ \t]*;/y;
  semicolon.lastIndex = at;
  return semicolon.exec(text) === null ? at : semicolon.lastIndex;
}

/**
 * Reads a call chain from the outside in. A chain call is collected until `find` or `aggregate` is
 * reached, so `chain` ends up in source order.
 */
function statementOf(
  node: Expression | Super,
  chain: readonly ChainCall[] = [],
): Outcome<QueryStatement> {
  if (node.type !== 'CallExpression') return refuse('not a find or aggregate call');
  const { callee } = node;
  if (callee.type !== 'MemberExpression') return refuse('not a method call');
  const method = propertyName(callee);
  if (method === 'find') return findOf(callee, node.arguments, chain);
  if (method === 'aggregate') {
    return chain.length > 0
      ? refuse('only find takes a chain')
      : aggregateOf(callee, node.arguments);
  }
  if (method === undefined || !CHAIN_METHODS.has(method)) {
    return refuse(`method ${method ?? '(computed)'} is not allowed here`);
  }
  return statementOf(callee.object, [{ method, args: node.arguments }, ...chain]);
}

function findOf(
  callee: MemberExpression,
  args: readonly Argument[],
  chain: readonly ChainCall[],
): Outcome<FindStatement> {
  if (args.length > 2) return refuse('find takes a filter and a projection');
  const collection = collectionOf(callee.object);
  if ('unsupported' in collection) return collection;
  const filter = optionalObject(args[0]);
  if ('unsupported' in filter) return filter;
  const projection = optionalObject(args[1]);
  if ('unsupported' in projection) return projection;
  const parts = chainParts(chain);
  if ('unsupported' in parts) return parts;
  return {
    value: {
      kind: 'find',
      collection: collection.value,
      filter: filterFromEjson(filter.value),
      projection: projectionFromEjson(projection.value),
      sort: parts.value.sort,
      skip: parts.value.skip,
      limit: parts.value.limit,
    },
  };
}

function aggregateOf(
  callee: MemberExpression,
  args: readonly Argument[],
): Outcome<AggregateStatement> {
  const collection = collectionOf(callee.object);
  if ('unsupported' in collection) return collection;
  const [pipeline] = args;
  if (
    args.length !== 1 ||
    pipeline === undefined ||
    pipeline === null ||
    pipeline.type !== 'ArrayExpression'
  ) {
    return refuse('aggregate takes one array of stages');
  }
  const stages: PipelineStage[] = [];
  for (const element of pipeline.elements) {
    const object = objectOf(element);
    if ('unsupported' in object) return object;
    const stage = stageFromEjson(object.value);
    if (stage === null) return refuse('a stage has no known form');
    stages.push(stage);
  }
  return { value: { kind: 'aggregate', collection: collection.value, stages } };
}

/** `db.<name>` or `db.getCollection('<name>')` with a string literal. */
function collectionOf(node: Expression | Super): Outcome<string> {
  if (
    node.type === 'MemberExpression' &&
    isDb(node.object) &&
    !node.computed &&
    node.property.type === 'Identifier'
  ) {
    return { value: node.property.name };
  }
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    isDb(node.callee.object)
  ) {
    const [arg] = node.arguments;
    if (
      propertyName(node.callee) === 'getCollection' &&
      node.arguments.length === 1 &&
      arg?.type === 'Literal' &&
      typeof arg.value === 'string'
    ) {
      return { value: arg.value };
    }
  }
  return refuse('not db.<name> or db.getCollection(name)');
}

function isDb(node: Expression | Super): boolean {
  return node.type === 'Identifier' && node.name === 'db';
}

function propertyName(callee: MemberExpression): string | undefined {
  return !callee.computed && callee.property.type === 'Identifier'
    ? callee.property.name
    : undefined;
}

/** Each call has one argument. A repeated call is unsupported, because the model keeps one value. */
function chainParts(calls: readonly ChainCall[]): Outcome<ChainParts> {
  const parts: { sort: SortRow[]; skip: number | null; limit: number | null } = {
    sort: [],
    skip: null,
    limit: null,
  };
  const seen = new Set<string>();
  for (const { method, args } of calls) {
    if (seen.has(method)) return refuse(`${method} is set twice`);
    seen.add(method);
    if (args.length !== 1) return refuse(`${method} takes one argument`);
    const [arg] = args;
    if (method === 'sort') {
      const object = objectOf(arg);
      if ('unsupported' in object) return object;
      const rows = sortFromEjson(object.value);
      if (rows === null) return refuse('sort direction is not 1 or -1');
      parts.sort = rows;
    } else {
      const count = numberOf(arg);
      if ('unsupported' in count) return count;
      if (method === 'skip') parts.skip = count.value;
      else parts.limit = count.value;
    }
  }
  return { value: parts };
}

/** The argument when present, else the empty object. */
function optionalObject(arg: Argument): Outcome<Plain> {
  return arg === undefined ? { value: {} } : objectOf(arg);
}

/** An object literal. A call such as `ObjectId(...)` is not an object literal, even though it reads as one. */
function objectOf(node: Argument): Outcome<Plain> {
  if (node === undefined || node === null || node.type !== 'ObjectExpression') {
    return refuse('needs an object literal');
  }
  const value = parseLiteral(node);
  if ('unsupported' in value) return value;
  return isPlainObject(value.value) ? { value: value.value } : refuse('needs an object literal');
}

function numberOf(node: Argument): Outcome<number> {
  if (node === undefined || node === null || node.type === 'SpreadElement') {
    return refuse('needs one number');
  }
  const value = parseLiteral(node);
  if ('unsupported' in value) return value;
  return typeof value.value === 'number' ? { value: value.value } : refuse('needs one number');
}
