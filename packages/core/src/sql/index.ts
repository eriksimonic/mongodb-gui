/**
 * The entry point of the T-SQL to mongosh translator. `translateSql` takes the editor text, splits
 * it into statements, parses and translates each one and prints it as mongosh. A failure in one
 * statement does not stop the others: each statement gets its own result with either the
 * translation or the error and the span to underline.
 */
import { SqlError, type Span } from './ast';
import { emitStatement } from './emit';
import { type MongoStatement } from './mongo-model';
import { parseStatement, splitSqlStatements } from './parser';
import { translateStatement, type TranslateOptions } from './translate';

export {
  SqlError,
  type Span,
  type SqlStatement,
  type SelectStatement,
  type UpdateStatement,
  type DeleteStatement,
  type InsertStatement,
  type Expression,
  type SqlType,
} from './ast';
export {
  SPECIAL,
  isMongoSpecial,
  mongoDate,
  mongoNow,
  mongoObjectId,
  mongoRegex,
  type MongoChainCall,
  type MongoObject,
  type MongoSpecial,
  type MongoStatement,
  type MongoValue,
} from './mongo-model';
export { parseSql, parseStatement, splitSqlStatements } from './parser';
export { translateStatement, type FieldTypeHint, type TranslateOptions } from './translate';
export { emitStatement, emitValue } from './emit';

/** One translated SQL statement with its source text and the mongosh text to run. */
export interface SqlTranslation {
  /** The span of the SQL statement in the full text. */
  readonly span: Span;
  /** The statement text. */
  readonly sql: string;
  readonly statement: MongoStatement;
  /** `emitStatement(statement)`. */
  readonly mongosh: string;
}

export interface SqlTranslationError {
  readonly message: string;
  /** The span of the SQL that caused the error, absolute in the full text. */
  readonly span: Span;
}

export type SqlTranslationResult =
  | { readonly ok: true; readonly translation: SqlTranslation }
  | { readonly ok: false; readonly span: Span; readonly error: SqlTranslationError };

/**
 * Translates every statement of the editor text in order. Statements end at `;` or at a `GO` on
 * its own line. A statement that fails to parse or translate yields an error result whose `span`
 * covers the statement and whose `error.span` points at the clause; the other statements still
 * translate. Empty text yields an empty array.
 */
export function translateSql(text: string, options?: TranslateOptions): SqlTranslationResult[] {
  return splitSqlStatements(text).map((span) => translateAt(text, span, options));
}

/**
 * Translates text that holds one statement. Throws nothing. Text with several statements yields
 * an error that says so, and empty text an error about the empty statement.
 */
export function translateSqlStatement(
  text: string,
  options?: TranslateOptions,
): SqlTranslationResult {
  const spans = splitSqlStatements(text);
  const whole = { start: 0, end: text.length };
  const [first] = spans;
  if (!first) {
    return { ok: false, span: whole, error: { message: 'the statement is empty', span: whole } };
  }
  const second = spans[1];
  if (second) {
    return {
      ok: false,
      span: whole,
      error: {
        message: 'expected one statement but found several',
        span: { start: second.start, end: text.length },
      },
    };
  }
  return translateAt(text, first, options);
}

function translateAt(
  text: string,
  span: Span,
  options: TranslateOptions | undefined,
): SqlTranslationResult {
  const sql = text.slice(span.start, span.end);
  try {
    const parsed = parseStatement(sql, span.start);
    const statement = translateStatement(parsed, options);
    return {
      ok: true,
      translation: { span, sql, statement, mongosh: emitStatement(statement) },
    };
  } catch (error) {
    return { ok: false, span, error: describe(error, span) };
  }
}

/** The message and span of a failure. An error that is not a `SqlError` points at the statement. */
function describe(error: unknown, span: Span): SqlTranslationError {
  if (error instanceof SqlError) {
    return { message: error.message, span: error.span };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { message, span };
}
