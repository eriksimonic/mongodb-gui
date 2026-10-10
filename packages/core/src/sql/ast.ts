/**
 * The syntax tree of the T-SQL subset the editor translates to mongosh. The parser builds it and
 * the translator reads it. Every node carries the span of its source text, so an error can point at
 * the clause that caused it.
 */

/** Offsets into the SQL text. `end` is exclusive. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** A translation or parse failure, pointing at the SQL that caused it. */
export class SqlError extends Error {
  readonly span: Span;

  constructor(message: string, span: Span) {
    super(message);
    this.name = 'SqlError';
    this.span = span;
  }
}

export type SqlStatement = SelectStatement | UpdateStatement | DeleteStatement | InsertStatement;

/** A table in FROM, JOIN, UPDATE, DELETE or INSERT. A `dbo.` prefix is dropped by the parser. */
export interface TableRef {
  readonly name: string;
  readonly alias: string | undefined;
  readonly span: Span;
}

export interface SelectStatement {
  readonly kind: 'select';
  readonly span: Span;
  readonly distinct: boolean;
  /** `TOP n`. */
  readonly top: number | undefined;
  readonly columns: readonly SelectColumn[];
  readonly from: TableRef;
  readonly joins: readonly JoinClause[];
  readonly where: Expression | undefined;
  readonly groupBy: readonly Expression[];
  readonly having: Expression | undefined;
  readonly orderBy: readonly OrderItem[];
  /** `OFFSET n ROWS`. */
  readonly offset: number | undefined;
  /** `FETCH NEXT n ROWS ONLY`. */
  readonly fetch: number | undefined;
}

export type SelectColumn =
  /** `*` or `alias.*`. */
  | { readonly kind: 'star'; readonly qualifier: string | undefined; readonly span: Span }
  | {
      readonly kind: 'expression';
      readonly expression: Expression;
      /** `AS name`, `name` after the expression, or `name = expression`. */
      readonly alias: string | undefined;
      readonly span: Span;
    };

export interface JoinClause {
  readonly join: 'inner' | 'left';
  readonly table: TableRef;
  readonly on: Expression;
  readonly span: Span;
}

export interface OrderItem {
  readonly expression: Expression;
  readonly direction: 'asc' | 'desc';
  readonly span: Span;
}

export interface UpdateStatement {
  readonly kind: 'update';
  readonly span: Span;
  readonly table: TableRef;
  readonly assignments: readonly Assignment[];
  readonly where: Expression | undefined;
}

export interface Assignment {
  readonly column: ColumnRef;
  readonly value: Expression;
  readonly span: Span;
}

export interface DeleteStatement {
  readonly kind: 'delete';
  readonly span: Span;
  readonly table: TableRef;
  readonly where: Expression | undefined;
}

export interface InsertStatement {
  readonly kind: 'insert';
  readonly span: Span;
  readonly table: TableRef;
  /** The column list is required. The parser rejects `INSERT INTO t VALUES (...)`. */
  readonly columns: readonly ColumnRef[];
  /** One entry per `(...)` row of VALUES, each with as many expressions as there are columns. */
  readonly rows: readonly (readonly Expression[])[];
}

export type Expression =
  | ColumnRef
  | Literal
  | BinaryExpression
  | UnaryExpression
  | InExpression
  | BetweenExpression
  | LikeExpression
  | IsNullExpression
  | CallExpression
  | CaseExpression
  | CastExpression;

/**
 * A column, with its dotted parts in order. `o.address.city` is `['o', 'address', 'city']`. The
 * parser does not know which parts are aliases, so the translator resolves the first part against
 * the table aliases of the statement. Bracketed and double-quoted parts are unwrapped.
 */
export interface ColumnRef {
  readonly kind: 'column';
  readonly parts: readonly string[];
  readonly span: Span;
}

export interface Literal {
  readonly kind: 'literal';
  readonly value: string | number | boolean | null;
  readonly span: Span;
}

export type BinaryOperator =
  '=' | '<>' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '%' | 'and' | 'or';

export interface BinaryExpression {
  readonly kind: 'binary';
  readonly operator: BinaryOperator;
  readonly left: Expression;
  readonly right: Expression;
  readonly span: Span;
}

export interface UnaryExpression {
  readonly kind: 'unary';
  readonly operator: 'not' | 'negate';
  readonly operand: Expression;
  readonly span: Span;
}

export interface InExpression {
  readonly kind: 'in';
  readonly expression: Expression;
  readonly values: readonly Expression[];
  readonly negated: boolean;
  readonly span: Span;
}

export interface BetweenExpression {
  readonly kind: 'between';
  readonly expression: Expression;
  readonly low: Expression;
  readonly high: Expression;
  readonly negated: boolean;
  readonly span: Span;
}

export interface LikeExpression {
  readonly kind: 'like';
  readonly expression: Expression;
  readonly pattern: Expression;
  /** The character of an `ESCAPE 'c'` clause. */
  readonly escape: string | undefined;
  readonly negated: boolean;
  readonly span: Span;
}

export interface IsNullExpression {
  readonly kind: 'isNull';
  readonly expression: Expression;
  readonly negated: boolean;
  readonly span: Span;
}

/** A function call such as `COUNT(*)`, `SUM(total)`, `COUNT(DISTINCT city)` or `ISNULL(a, 0)`. */
export interface CallExpression {
  readonly kind: 'call';
  /** Upper case, as the translator's function table is keyed. */
  readonly name: string;
  readonly args: readonly Expression[];
  /** `COUNT(*)`. The args are empty. */
  readonly star: boolean;
  /** `COUNT(DISTINCT col)`. */
  readonly distinct: boolean;
  readonly span: Span;
}

export interface CaseExpression {
  readonly kind: 'case';
  /** The operand of a simple `CASE x WHEN 1 THEN ...`. Undefined for a searched CASE. */
  readonly operand: Expression | undefined;
  readonly whens: readonly { readonly when: Expression; readonly then: Expression }[];
  readonly else: Expression | undefined;
  readonly span: Span;
}

/**
 * `CAST(x AS type)` and `CONVERT(type, x)`. The parser maps the T-SQL type names: INT, INTEGER,
 * SMALLINT and TINYINT to `int`; BIGINT to `bigint`; FLOAT and REAL to `float`; DECIMAL, NUMERIC
 * and MONEY to `decimal`; BIT to `bit`; DATE to `date`; DATETIME, DATETIME2, SMALLDATETIME and
 * DATETIMEOFFSET to `datetime`; VARCHAR, NVARCHAR, CHAR, NCHAR, TEXT and NTEXT to `string`;
 * OBJECTID (an extension for MongoDB ids) to `objectId`.
 */
export interface CastExpression {
  readonly kind: 'cast';
  readonly expression: Expression;
  readonly type: SqlType;
  readonly span: Span;
}

export type SqlType =
  'int' | 'bigint' | 'float' | 'decimal' | 'bit' | 'date' | 'datetime' | 'string' | 'objectId';
