import type { PlanVerbosity } from './plan-tree';

export const EXPLAIN_NEEDS_ONE_QUERY = 'Explain needs one collection query';
export const COUNT_OPTIONS_NOT_EXPLAINED = 'Explain does not support countDocuments options';

export type ExplainRewrite =
  | {
      readonly ok: true;
      // The statement with the explain call in place. Comments are gone.
      readonly code: string;
      readonly collection: string;
      readonly operation: string;
    }
  | { readonly ok: false; readonly message: string };

interface CollectionAccess {
  // How the statement names the collection, for example orders or getCollection("order-items").
  readonly text: string;
  // The plain collection name.
  readonly name: string;
}

// Methods that return a cursor. The explain call goes at the end of the chain.
const CURSOR_METHODS: ReadonlySet<string> = new Set(['find', 'aggregate']);
// Methods that take a call of the form db.<coll>.explain(verbosity).<method>(...), or a legacy
// call that mongosh explains in their place.
const PREFIX_METHODS: ReadonlySet<string> = new Set([
  'count',
  'distinct',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'update',
  'remove',
]);
// Cursor modifiers that may follow find or aggregate. Terminal methods such as toArray are not
// on this list, so they refuse the statement.
const MODIFIERS: ReadonlySet<string> = new Set([
  'allowDiskUse',
  'batchSize',
  'collation',
  'comment',
  'hint',
  'let',
  'limit',
  'max',
  'maxAwaitTimeMS',
  'maxTimeMS',
  'min',
  'noCursorTimeout',
  'project',
  'readConcern',
  'readPref',
  'returnKey',
  'showRecordId',
  'skip',
  'sort',
]);

interface Segment {
  readonly name: string;
  // The text between the parentheses, or undefined when the segment has no call.
  readonly args: string | undefined;
}

const WHITESPACE = /\s/;
const CLOSERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };

// Characters after which a slash starts a regular expression rather than a division.
const REGEX_AFTER: ReadonlySet<string> = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
]);

// Rewrites the single collection query in a statement so the server returns its plan instead of
// running it. The statement is never evaluated here. Comments are removed from the output.
export function rewriteForExplain(code: string, verbosity: PlanVerbosity): ExplainRewrite {
  const refused: ExplainRewrite = { ok: false, message: EXPLAIN_NEEDS_ONE_QUERY };
  const text = trimStatement(stripComments(code));
  const segments = parseChain(text);
  if (segments === undefined || segments.length < 2) {
    return refused;
  }
  const collection = collectionSegment(segments[0]);
  // The prefix form db.<coll>.explain(<verbosity>).<method>(...) is the same query. Its own
  // verbosity is dropped, and the requested one takes its place. Without the call parentheses,
  // explain is a property and not the prefix form, so the statement is refused.
  const explainSegment = segments[1];
  if (explainSegment?.name === 'explain' && explainSegment.args === undefined) {
    return refused;
  }
  const hasPrefix = explainSegment?.name === 'explain' && segments.length > 2;
  const afterCollection = hasPrefix ? segments.slice(2) : segments.slice(1);
  const method = afterCollection[0];
  if (collection === undefined || method === undefined || method.args === undefined) {
    return refused;
  }
  const rest = afterCollection.slice(1);
  const explain = `.explain("${verbosity}")`;
  const operation = method.name;

  if (CURSOR_METHODS.has(operation)) {
    const modifiers = dropTrailingExplain(rest);
    if (modifiers === undefined || !modifiers.every(isModifier)) {
      return refused;
    }
    const chain = modifiers.map((segment) => `.${segment.name}(${segment.args ?? ''})`).join('');
    return ok(
      `db.${collection.text}.${operation}(${method.args})${chain}${explain}`,
      collection.name,
      operation,
    );
  }
  if (operation === 'findOne') {
    const modifiers = dropTrailingExplain(rest);
    if (modifiers === undefined || modifiers.length > 0) {
      return refused;
    }
    return ok(
      `db.${collection.text}.find(${method.args}).limit(1)${explain}`,
      collection.name,
      operation,
    );
  }
  if (operation === 'countDocuments') {
    return countDocumentsExplain(collection, method.args, rest.length > 0, verbosity);
  }
  if (PREFIX_METHODS.has(operation)) {
    const args = splitArguments(method.args);
    const code =
      args === undefined
        ? undefined
        : prefixExplain(operation, args, rest.length > 0, collection, verbosity);
    return code === undefined ? refused : ok(code, collection.name, operation);
  }
  return refused;
}

function ok(code: string, collection: string, operation: string): ExplainRewrite {
  return { ok: true, code, collection, operation };
}

// A statement may end with one semicolon. Anything else after the chain is refused.
function trimStatement(text: string): string {
  const trimmed = text.trim();
  return trimmed.endsWith(';') ? trimmed.slice(0, -1).trim() : trimmed;
}

// The first segment names the collection: db.<name> or db.getCollection(<string>).
function collectionSegment(segment: Segment | undefined): CollectionAccess | undefined {
  if (segment === undefined) {
    return undefined;
  }
  if (segment.name === 'getCollection') {
    const name = unquote(segment.args ?? '');
    return name === undefined ? undefined : { text: `getCollection(${segment.args ?? ''})`, name };
  }
  return segment.args === undefined ? { text: segment.name, name: segment.name } : undefined;
}

// The text inside one quoted string literal with no quotes, backslashes or backticks in it.
function unquote(text: string): string | undefined {
  const trimmed = text.trim();
  const quote = trimmed.charAt(0);
  if (trimmed.length < 3 || (quote !== '"' && quote !== "'" && quote !== '`')) {
    return undefined;
  }
  if (trimmed.charAt(trimmed.length - 1) !== quote) {
    return undefined;
  }
  const inner = trimmed.slice(1, -1);
  // A template placeholder would run code when the statement is evaluated, so it is refused.
  if (inner.includes('${')) {
    return undefined;
  }
  for (const char of inner) {
    if (char === quote || char === '\\' || char === '`' || char === '"' || char === "'") {
      return undefined;
    }
  }
  return inner;
}

// Removes a trailing .explain(...) so the caller can add the requested verbosity. An explain in
// any other position refuses the statement, because the rest of the chain would run on the plan.
function dropTrailingExplain(segments: readonly Segment[]): Segment[] | undefined {
  const explainAt = segments.findIndex((segment) => segment.name === 'explain');
  if (explainAt === -1) {
    return [...segments];
  }
  if (explainAt !== segments.length - 1) {
    return undefined;
  }
  return segments.slice(0, -1);
}

function isModifier(segment: Segment): boolean {
  return MODIFIERS.has(segment.name) && segment.args !== undefined;
}

// Explain for the methods that mongosh exposes through db.<coll>.explain(verbosity). The modern
// write methods map onto the legacy update and remove calls, which mongosh explains. The server
// runs the same plan for both.
function prefixExplain(
  operation: string,
  args: readonly string[],
  chained: boolean,
  collection: CollectionAccess,
  verbosity: PlanVerbosity,
): string | undefined {
  if (chained) {
    return undefined;
  }
  const head = `db.${collection.text}.explain("${verbosity}")`;
  const [first = '{}', second, third] = args;
  switch (operation) {
    case 'count':
    case 'distinct':
    case 'update':
    case 'remove':
      return `${head}.${operation}(${args.join(', ')})`;
    // The caller's options are spread into the legacy options object, so each option is kept as
    // written. mongosh's legacy update reads only some of them, though. An option it ignores, such
    // as arrayFilters on a path it does not read, can give a different plan from the real call.
    case 'updateOne':
    case 'updateMany': {
      if (second === undefined) {
        return undefined;
      }
      const multi = operation === 'updateMany' ? 'true' : 'false';
      return `${head}.update(${first}, ${second}, ${optionsWith(third, `multi: ${multi}`)})`;
    }
    case 'replaceOne': {
      // The legacy update rejects a replacement document, so the plan comes from findOneAndReplace.
      if (second === undefined) {
        return undefined;
      }
      const options = third === undefined ? '' : `, ${third}`;
      return `${head}.findOneAndReplace(${first}, ${second}${options})`;
    }
    case 'deleteOne':
    case 'deleteMany': {
      const justOne = operation === 'deleteOne' ? 'true' : 'false';
      return `${head}.remove(${first}, ${optionsWith(second, `justOne: ${justOne}`)})`;
    }
    default:
      return undefined;
  }
}

// Explain for countDocuments. The driver runs it as an aggregate with $match and $group, so the
// explain uses the same pipeline. Options such as skip and limit change the plan, so they refuse.
function countDocumentsExplain(
  collection: CollectionAccess,
  args: string,
  chained: boolean,
  verbosity: PlanVerbosity,
): ExplainRewrite {
  if (chained) {
    return { ok: false, message: EXPLAIN_NEEDS_ONE_QUERY };
  }
  const parts = splitArguments(args);
  if (parts === undefined) {
    return { ok: false, message: EXPLAIN_NEEDS_ONE_QUERY };
  }
  if (parts.length > 1) {
    return { ok: false, message: COUNT_OPTIONS_NOT_EXPLAINED };
  }
  const filter = parts[0] || '{}';
  const pipeline = `[{ $match: ${filter} }, { $group: { _id: 1, n: { $sum: 1 } } }]`;
  return ok(
    `db.${collection.text}.explain("${verbosity}").aggregate(${pipeline})`,
    collection.name,
    'countDocuments',
  );
}

// An options object with one field added. The caller's options, when present, come first so the
// added field wins.
function optionsWith(options: string | undefined, field: string): string {
  return options === undefined ? `{ ${field} }` : `{ ...(${options}), ${field} }`;
}

// Splits the text between parentheses at the top-level commas. Undefined when a bracket does not
// balance. Empty text gives no parts.
function splitArguments(args: string): string[] | undefined {
  if (args.trim() === '') {
    return [];
  }
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let previous: string | undefined;
  let pos = 0;
  while (pos < args.length) {
    const literal = literalEnd(args, pos, previous);
    if (literal !== undefined) {
      previous = args.charAt(literal - 1);
      pos = literal;
      continue;
    }
    const char = args.charAt(pos);
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth < 0) {
        return undefined;
      }
    } else if (char === ',' && depth === 0) {
      parts.push(args.slice(start, pos).trim());
      start = pos + 1;
    }
    if (!WHITESPACE.test(char)) {
      previous = char;
    }
    pos += 1;
  }
  if (depth !== 0) {
    return undefined;
  }
  parts.push(args.slice(start).trim());
  return parts;
}

// Parses db followed by a chain of .name or .name(args) segments. Returns undefined when the text
// is not exactly one such chain.
function parseChain(text: string): Segment[] | undefined {
  if (!text.startsWith('db')) {
    return undefined;
  }
  const segments: Segment[] = [];
  let pos = 2;
  for (;;) {
    pos = skipWhitespace(text, pos);
    // db["orders"] names the collection like db.getCollection("orders"). It may only come first.
    if (segments.length === 0 && text.charAt(pos) === '[') {
      const close = matchingClose(text, pos);
      const inner = close === undefined ? undefined : text.slice(pos + 1, close).trim();
      if (close === undefined || inner === undefined || unquote(inner) === undefined) {
        return undefined;
      }
      segments.push({ name: 'getCollection', args: inner });
      pos = close + 1;
      continue;
    }
    if (text.charAt(pos) !== '.') {
      break;
    }
    pos = skipWhitespace(text, pos + 1);
    const name = identifierAt(text, pos);
    if (name === undefined) {
      return undefined;
    }
    pos += name.length;
    const open = skipWhitespace(text, pos);
    if (text.charAt(open) === '(') {
      const close = matchingClose(text, open);
      if (close === undefined) {
        return undefined;
      }
      segments.push({ name, args: text.slice(open + 1, close).trim() });
      pos = close + 1;
    } else {
      segments.push({ name, args: undefined });
    }
  }
  return skipWhitespace(text, pos) === text.length ? segments : undefined;
}

function identifierAt(text: string, pos: number): string | undefined {
  const match = /^[A-Za-z_$][\w$]*/.exec(text.slice(pos));
  return match?.[0];
}

function skipWhitespace(text: string, from: number): number {
  let pos = from;
  while (pos < text.length && WHITESPACE.test(text.charAt(pos))) {
    pos += 1;
  }
  return pos;
}

// Index of the bracket that closes the one at `open`, or undefined when the brackets do not
// balance. Strings, template literals, regular expressions and comments are skipped.
function matchingClose(text: string, open: number): number | undefined {
  const stack: string[] = [];
  let previous: string | undefined;
  let pos = open;
  while (pos < text.length) {
    const comment = commentEnd(text, pos);
    if (comment !== undefined) {
      pos = comment;
      continue;
    }
    const literal = literalEnd(text, pos, previous);
    if (literal !== undefined) {
      previous = text.charAt(literal - 1);
      pos = literal;
      continue;
    }
    const char = text.charAt(pos);
    const closer = CLOSERS[char];
    if (closer !== undefined) {
      stack.push(closer);
    } else if (char === ')' || char === ']' || char === '}') {
      if (stack.pop() !== char) {
        return undefined;
      }
      if (stack.length === 0) {
        return pos;
      }
    }
    if (!WHITESPACE.test(char)) {
      previous = char;
    }
    pos += 1;
  }
  return undefined;
}

// Removes // and /* */ comments. Each comment becomes one space, so tokens on either side stay
// apart.
function stripComments(text: string): string {
  let output = '';
  let previous: string | undefined;
  let pos = 0;
  while (pos < text.length) {
    const comment = commentEnd(text, pos);
    if (comment !== undefined) {
      output += ' ';
      pos = comment;
      continue;
    }
    const literal = literalEnd(text, pos, previous);
    if (literal !== undefined) {
      output += text.slice(pos, literal);
      previous = text.charAt(literal - 1);
      pos = literal;
      continue;
    }
    const char = text.charAt(pos);
    output += char;
    if (!WHITESPACE.test(char)) {
      previous = char;
    }
    pos += 1;
  }
  return output;
}

// End of the comment that starts at `start`, or undefined when no comment starts there.
function commentEnd(text: string, start: number): number | undefined {
  if (text.charAt(start) !== '/') {
    return undefined;
  }
  if (text.charAt(start + 1) === '/') {
    const newline = text.indexOf('\n', start);
    return newline === -1 ? text.length : newline;
  }
  if (text.charAt(start + 1) === '*') {
    const close = text.indexOf('*/', start + 2);
    return close === -1 ? text.length : close + 2;
  }
  return undefined;
}

// End of the string, template literal or regular expression that starts at `start`, or undefined
// when none starts there. An unterminated literal runs to the end of the text.
function literalEnd(text: string, start: number, previous: string | undefined): number | undefined {
  const char = text.charAt(start);
  if (char === '"' || char === "'" || char === '`') {
    return closeLiteral(text, start, char);
  }
  if (char === '/' && REGEX_AFTER.has(previous ?? '')) {
    return closeRegex(text, start);
  }
  return undefined;
}

function closeLiteral(text: string, start: number, quote: string): number {
  for (let pos = start + 1; pos < text.length; pos += 1) {
    const current = text.charAt(pos);
    if (current === '\\') {
      pos += 1;
    } else if (current === quote) {
      return pos + 1;
    }
  }
  return text.length;
}

function closeRegex(text: string, start: number): number {
  let inClass = false;
  for (let pos = start + 1; pos < text.length; pos += 1) {
    const current = text.charAt(pos);
    if (current === '\\') {
      pos += 1;
    } else if (current === '[') {
      inClass = true;
    } else if (current === ']') {
      inClass = false;
    } else if (current === '/' && !inClass) {
      return pos + 1;
    }
  }
  return text.length;
}
