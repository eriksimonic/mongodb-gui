/**
 * Prepares the mongosh for a SQL run. The translator coerces a string literal compared with a date
 * or id field only when it knows the field's type, so the run translates twice. The first pass
 * records which collections the statements read, the sampler gives their fields, and the second
 * pass translates with the sampled types.
 */
import {
  translateSql,
  type FieldTypeHint,
  type MongoStatement,
  type SchemaField,
  type Span,
} from '@mongo-gui/core';

/** What the run needs from the completion source: the sampled fields of a collection. */
export interface SqlSampler {
  fieldsOf(collection: string): Promise<SchemaField[]>;
}

/** A write that touches every document of its collection, such as an UPDATE without WHERE. */
export interface UnsafeWrite {
  readonly statement: 'UPDATE' | 'DELETE';
  readonly collection: string;
}

export type SqlRunPlan =
  | {
      readonly ok: true;
      /** The mongosh of every statement, joined with `;` and a newline. */
      readonly mongosh: string;
      /** True when any statement writes every document of its collection. */
      readonly unsafe: boolean;
      readonly unsafeWrites: readonly UnsafeWrite[];
    }
  | {
      readonly ok: false;
      readonly message: string;
      /** The span of the SQL that caused the error, relative to the text that was given. */
      readonly span: Span;
    };

/** The sampled BSON type names the translator has a hint for. */
const TYPE_HINTS: Readonly<Record<string, FieldTypeHint>> = {
  Date: 'date',
  ObjectId: 'objectId',
  Int32: 'number',
  Long: 'number',
  Double: 'number',
  Decimal128: 'number',
  Boolean: 'bool',
  String: 'string',
};

/** Types a field can hold beside its real type without making the hint ambiguous. */
const ABSENT_TYPES: ReadonlySet<string> = new Set(['Null', 'Undefined']);

/**
 * Translates SQL to mongosh with the field types of the sampled collections. Multi-statement text
 * yields the statements joined with `;\n`. The first statement that fails yields its error, and
 * nothing runs. A sampler failure counts as a collection without known types.
 */
export async function prepareSqlRun(sql: string, sampler: SqlSampler): Promise<SqlRunPlan> {
  const collections = new Set<string>();
  const first = translateSql(sql, {
    fieldType: (collection) => {
      collections.add(collection);
      return undefined;
    },
  });
  const failure = first.find((result) => !result.ok);
  if (failure !== undefined && !failure.ok) {
    return { ok: false, message: failure.error.message, span: failure.error.span };
  }
  for (const result of first) {
    if (result.ok) {
      collections.add(result.translation.statement.collection);
    }
  }
  const hints = await sampleHints(collections, sampler);
  const results = translateSql(sql, {
    fieldType: (collection, path) => hints.get(collection)?.get(path),
  });
  const statements: MongoStatement[] = [];
  const mongosh: string[] = [];
  for (const result of results) {
    if (!result.ok) {
      return { ok: false, message: result.error.message, span: result.error.span };
    }
    statements.push(result.translation.statement);
    mongosh.push(result.translation.mongosh);
  }
  if (mongosh.length === 0) {
    const span = { start: 0, end: sql.length };
    return { ok: false, message: 'the statement is empty', span };
  }
  const unsafeWrites = statements.filter((item) => item.unsafe).map(unsafeWriteOf);
  return {
    ok: true,
    mongosh: mongosh.join(';\n'),
    unsafe: unsafeWrites.length > 0,
    unsafeWrites,
  };
}

/** The type hints of every field of the collections, keyed by collection, then by dotted path. */
async function sampleHints(
  collections: ReadonlySet<string>,
  sampler: SqlSampler,
): Promise<Map<string, Map<string, FieldTypeHint>>> {
  const names = [...collections];
  const samples = await Promise.all(
    names.map((name) =>
      Promise.resolve()
        .then(() => sampler.fieldsOf(name))
        .catch((): SchemaField[] => []),
    ),
  );
  const hints = new Map<string, Map<string, FieldTypeHint>>();
  names.forEach((name, index) => {
    hints.set(name, fieldHints(samples[index] ?? []));
  });
  return hints;
}

/**
 * The type hint of each sampled field by its dotted path. A field with one real type gets that
 * type's hint. Null and undefined beside it do not count. A field with several real types, or a
 * type without a hint, gets none.
 */
export function fieldHints(fields: readonly SchemaField[]): Map<string, FieldTypeHint> {
  const hints = new Map<string, FieldTypeHint>();
  for (const field of fields) {
    const hint = hintOf(field.types);
    if (hint !== undefined) {
      hints.set(field.path, hint);
    }
  }
  return hints;
}

/** The hint for the BSON type names of one field, or undefined when they do not name one type. */
export function hintOf(types: readonly string[]): FieldTypeHint | undefined {
  const real = types.filter((type) => !ABSENT_TYPES.has(type));
  const [only] = real;
  if (only === undefined || real.length > 1) {
    return undefined;
  }
  return TYPE_HINTS[only];
}

function unsafeWriteOf(statement: MongoStatement): UnsafeWrite {
  return {
    statement: statement.method === 'deleteMany' ? 'DELETE' : 'UPDATE',
    collection: statement.collection,
  };
}

/** The question the editor asks before it runs writes that touch every document. */
export function unsafeWriteQuestion(writes: readonly UnsafeWrite[]): string {
  const [first] = writes;
  if (first === undefined) {
    return '';
  }
  if (writes.length === 1) {
    return `This ${first.statement} has no WHERE and changes every document of ${first.collection}. Run it?`;
  }
  const list = writes.map((write) => `${write.statement} ${write.collection}`).join(', ');
  return `These statements have no WHERE and change every document of their collections: ${list}. Run them?`;
}
