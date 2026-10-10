/**
 * Turns a `MongoStatement` tree into mongosh text for the editor. Values print on one line, in
 * the style the editor's own formatter uses: single-quoted strings, bare keys where JavaScript
 * allows them, `ISODate`, `ObjectId` and regex literals for the special values. An aggregate
 * pipeline gets one stage per line so a reader can follow it.
 */
import { collectionAccess, quoteShellString } from '../shell/collection-access';
import {
  isMongoSpecial,
  SPECIAL,
  type MongoSpecial,
  type MongoStatement,
  type MongoValue,
} from './mongo-model';

/** A key that JavaScript accepts unquoted in an object literal. `$lookup` and `_id` qualify. */
const BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The body of a regex literal. An unescaped `/` would end the literal early, and a raw newline is
 * not allowed inside one, so both are escaped. A backslash keeps the character after it as is, so
 * a `/` the translator already escaped is not escaped twice.
 */
function regexBody(pattern: string): string {
  if (pattern === '') return '(?:)';
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] ?? '';
    if (char === '\\' && i + 1 < pattern.length) {
      out += char + (pattern[i + 1] ?? '');
      i += 1;
    } else if (char === '/') out += '\\/';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else out += char;
  }
  return out;
}

function emitSpecial(value: MongoSpecial): string {
  switch (value[SPECIAL]) {
    case 'date':
      return `ISODate(${quoteShellString(value.iso)})`;
    case 'now':
      return 'new Date()';
    case 'objectId':
      return `ObjectId(${quoteShellString(value.hex)})`;
    case 'regex':
      return `/${regexBody(value.pattern)}/${value.options}`;
  }
}

function emitKey(key: string): string {
  return BARE_KEY.test(key) ? key : quoteShellString(key);
}

/** One value as mongosh text on a single line. */
export function emitValue(value: MongoValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return quoteShellString(value);
  if (isMongoSpecial(value)) return emitSpecial(value);
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[${value.map(emitValue).join(', ')}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  return `{ ${entries.map(([key, item]) => `${emitKey(key)}: ${emitValue(item)}`).join(', ')} }`;
}

/**
 * A whole statement: the collection access, the method with its arguments, then the chain of
 * `.sort`, `.skip` and `.limit` calls. An `aggregate` with a single array argument prints each
 * stage on its own line.
 */
export function emitStatement(statement: MongoStatement): string {
  const access = collectionAccess(statement.collection);
  const [pipeline] = statement.args;
  const args =
    statement.method === 'aggregate' &&
    statement.args.length === 1 &&
    Array.isArray(pipeline) &&
    pipeline.length > 0
      ? `[\n${pipeline.map((stage) => `  ${emitValue(stage)}`).join(',\n')}\n]`
      : statement.args.map(emitValue).join(', ');
  const chain = statement.chain
    .map((call) => `.${call.method}(${call.args.map(emitValue).join(', ')})`)
    .join('');
  return `${access}.${statement.method}(${args})${chain}`;
}

export { collectionAccess };
