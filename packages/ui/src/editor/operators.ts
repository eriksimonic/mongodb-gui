/**
 * Static reference data for the editor: query and aggregation operators with a one-line doc, and
 * the signatures of common collection methods. Completion and signature help read this table.
 */

export interface OperatorEntry {
  readonly name: string;
  readonly doc: string;
}

export interface ParameterEntry {
  readonly name: string;
  readonly optional?: boolean;
}

export interface MethodEntry {
  readonly name: string;
  readonly params: readonly ParameterEntry[];
  readonly doc: string;
}

/** Query, update and aggregation operators. Each name starts with `$`. */
export const QUERY_OPERATORS: readonly OperatorEntry[] = [
  { name: '$eq', doc: 'Matches values equal to the given value.' },
  { name: '$ne', doc: 'Matches values not equal to the given value.' },
  { name: '$gt', doc: 'Matches values greater than the given value.' },
  { name: '$gte', doc: 'Matches values greater than or equal to the given value.' },
  { name: '$lt', doc: 'Matches values less than the given value.' },
  { name: '$lte', doc: 'Matches values less than or equal to the given value.' },
  { name: '$in', doc: 'Matches any value in the given array.' },
  { name: '$nin', doc: 'Matches no value in the given array.' },
  { name: '$and', doc: 'Joins query clauses with a logical AND.' },
  { name: '$or', doc: 'Joins query clauses with a logical OR.' },
  { name: '$nor', doc: 'Matches documents that fail every query clause.' },
  { name: '$not', doc: 'Inverts the result of an operator expression on a field.' },
  { name: '$exists', doc: 'Matches documents that have, or lack, the field.' },
  { name: '$type', doc: 'Matches values of the given BSON type.' },
  { name: '$regex', doc: 'Matches strings against a regular expression.' },
  { name: '$elemMatch', doc: 'Matches arrays with an element that meets every condition.' },
  { name: '$size', doc: 'Matches arrays with exactly the given number of elements.' },
  { name: '$all', doc: 'Matches arrays that contain every given value.' },
  { name: '$expr', doc: 'Allows aggregation expressions inside a query.' },
  { name: '$mod', doc: 'Matches numbers whose remainder on division equals the given value.' },
  { name: '$text', doc: 'Performs a text search on fields with a text index.' },
  { name: '$where', doc: 'Matches with a JavaScript expression. It is slow, so avoid it.' },
  {
    name: '$set',
    doc: 'Sets the value of a field. In an aggregation, adds fields, like $addFields.',
  },
  { name: '$unset', doc: 'Removes the named fields from a document.' },
  { name: '$inc', doc: 'Adds the given amount to a numeric field.' },
  { name: '$mul', doc: 'Multiplies a numeric field by the given amount.' },
  { name: '$min', doc: 'Sets a field to the value when that value is lower than the current one.' },
  {
    name: '$max',
    doc: 'Sets a field to the value when that value is higher than the current one.',
  },
  { name: '$rename', doc: 'Renames a field.' },
  { name: '$currentDate', doc: 'Sets a field to the current date or timestamp.' },
  { name: '$setOnInsert', doc: 'Sets a field only when an upsert inserts the document.' },
  { name: '$push', doc: 'Appends a value to an array field.' },
  { name: '$pull', doc: 'Removes every array element that matches the condition.' },
  { name: '$addToSet', doc: 'Appends a value to an array field when it is not already there.' },
  { name: '$pop', doc: 'Removes the first or last element of an array.' },
  { name: '$each', doc: 'Modifier for $push and $addToSet. Lists the values to add.' },
  { name: '$match', doc: 'Pipeline stage. Filters documents with a query.' },
  { name: '$group', doc: 'Pipeline stage. Groups documents by a key and computes accumulators.' },
  { name: '$project', doc: 'Pipeline stage. Keeps, drops or computes fields.' },
  { name: '$sort', doc: 'Pipeline stage. Orders documents by one or more fields.' },
  { name: '$limit', doc: 'Pipeline stage. Passes the first n documents on.' },
  { name: '$skip', doc: 'Pipeline stage. Skips the first n documents.' },
  { name: '$unwind', doc: 'Pipeline stage. Emits one document for each element of an array.' },
  { name: '$lookup', doc: 'Pipeline stage. Joins documents from another collection.' },
  { name: '$addFields', doc: 'Pipeline stage. Adds or overwrites fields and keeps the rest.' },
  {
    name: '$replaceRoot',
    doc: 'Pipeline stage. Replaces each document with an embedded document.',
  },
  { name: '$count', doc: 'Pipeline stage. Outputs the number of input documents as one document.' },
  { name: '$facet', doc: 'Pipeline stage. Runs several sub-pipelines on the same input.' },
  { name: '$bucket', doc: 'Pipeline stage. Groups documents into buckets by value ranges.' },
  { name: '$sample', doc: 'Pipeline stage. Returns a random sample of the documents.' },
  { name: '$out', doc: 'Pipeline stage. Writes the results to a collection, replacing it.' },
  { name: '$merge', doc: 'Pipeline stage. Writes the results to a collection, merging them in.' },
  { name: '$unionWith', doc: 'Pipeline stage. Appends the documents of another collection.' },
  {
    name: '$graphLookup',
    doc: 'Pipeline stage. Follows a recursive relationship between documents.',
  },
  { name: '$sum', doc: 'Accumulator. Totals the numeric values, or counts with 1.' },
  { name: '$avg', doc: 'Accumulator. Averages the numeric values.' },
  { name: '$first', doc: 'Accumulator. Takes the value from the first document of a group.' },
  { name: '$last', doc: 'Accumulator. Takes the value from the last document of a group.' },
  { name: '$cond', doc: 'Expression. Returns one of two values by a condition.' },
  { name: '$ifNull', doc: 'Expression. Returns a replacement when the value is null or missing.' },
  { name: '$switch', doc: 'Expression. Returns the value of the first matching branch.' },
  { name: '$concat', doc: 'Expression. Joins strings.' },
  { name: '$toLower', doc: 'Expression. Converts a string to lower case.' },
  { name: '$toUpper', doc: 'Expression. Converts a string to upper case.' },
  { name: '$add', doc: 'Expression. Adds numbers, or a number and a date.' },
  { name: '$subtract', doc: 'Expression. Subtracts a number or a date from another.' },
  { name: '$multiply', doc: 'Expression. Multiplies numbers.' },
  { name: '$divide', doc: 'Expression. Divides one number by another.' },
  { name: '$arrayElemAt', doc: 'Expression. Returns the element at the given array index.' },
  { name: '$filter', doc: 'Expression. Selects the array elements that match a condition.' },
  { name: '$map', doc: 'Expression. Applies an expression to every array element.' },
  { name: '$year', doc: 'Expression. Returns the year of a date.' },
  { name: '$month', doc: 'Expression. Returns the month of a date, from 1 to 12.' },
  { name: '$dayOfMonth', doc: 'Expression. Returns the day of the month of a date.' },
  { name: '$dateToString', doc: 'Expression. Formats a date as a string.' },
  { name: '$round', doc: 'Expression. Rounds a number to the given place.' },
  { name: '$toString', doc: 'Expression. Converts a value to a string.' },
  { name: '$toObjectId', doc: 'Expression. Converts a value to an ObjectId.' },
  { name: '$literal', doc: 'Expression. Returns the value without parsing it as an expression.' },
];

const FILTER: ParameterEntry = { name: 'filter' };
const OPTIONS: ParameterEntry = { name: 'options', optional: true };

/** Methods of a collection that the editor shows signatures for. */
export const COLLECTION_METHODS: readonly MethodEntry[] = [
  {
    name: 'find',
    params: [FILTER, { name: 'projection', optional: true }],
    doc: 'Returns a cursor over the documents that match the filter.',
  },
  {
    name: 'findOne',
    params: [FILTER, { name: 'projection', optional: true }],
    doc: 'Returns the first document that matches the filter, or null.',
  },
  {
    name: 'aggregate',
    params: [{ name: 'pipeline' }, OPTIONS],
    doc: 'Runs an aggregation pipeline and returns a cursor over the results.',
  },
  {
    name: 'countDocuments',
    params: [{ name: 'filter', optional: true }, OPTIONS],
    doc: 'Counts the documents that match the filter.',
  },
  {
    name: 'estimatedDocumentCount',
    params: [OPTIONS],
    doc: 'Returns the document count from collection metadata. It does not apply a filter.',
  },
  {
    name: 'distinct',
    params: [{ name: 'field' }, { name: 'filter', optional: true }, OPTIONS],
    doc: 'Returns the distinct values of a field.',
  },
  {
    name: 'insertOne',
    params: [{ name: 'document' }, OPTIONS],
    doc: 'Inserts one document. Adds an _id when the document has none.',
  },
  {
    name: 'insertMany',
    params: [{ name: 'documents' }, OPTIONS],
    doc: 'Inserts an array of documents.',
  },
  {
    name: 'updateOne',
    params: [FILTER, { name: 'update' }, OPTIONS],
    doc: 'Updates the first document that matches the filter.',
  },
  {
    name: 'updateMany',
    params: [FILTER, { name: 'update' }, OPTIONS],
    doc: 'Updates every document that matches the filter.',
  },
  {
    name: 'replaceOne',
    params: [FILTER, { name: 'replacement' }, OPTIONS],
    doc: 'Replaces the first document that matches the filter.',
  },
  {
    name: 'findOneAndUpdate',
    params: [FILTER, { name: 'update' }, OPTIONS],
    doc: 'Updates the first matching document and returns it, before or after the update.',
  },
  {
    name: 'findOneAndReplace',
    params: [FILTER, { name: 'replacement' }, OPTIONS],
    doc: 'Replaces the first matching document and returns it.',
  },
  {
    name: 'findOneAndDelete',
    params: [FILTER, OPTIONS],
    doc: 'Deletes the first matching document and returns it.',
  },
  {
    name: 'deleteOne',
    params: [FILTER, OPTIONS],
    doc: 'Deletes the first document that matches the filter.',
  },
  {
    name: 'deleteMany',
    params: [FILTER, OPTIONS],
    doc: 'Deletes every document that matches the filter.',
  },
  {
    name: 'bulkWrite',
    params: [{ name: 'operations' }, OPTIONS],
    doc: 'Runs a list of write operations in one call.',
  },
  {
    name: 'createIndex',
    params: [{ name: 'keys' }, OPTIONS],
    doc: 'Creates an index on the given keys.',
  },
  { name: 'dropIndex', params: [{ name: 'name' }], doc: 'Drops the index with the given name.' },
  { name: 'getIndexes', params: [], doc: 'Lists the indexes of the collection.' },
  {
    name: 'drop',
    params: [OPTIONS],
    doc: 'Drops the collection and its indexes. This cannot be undone.',
  },
  { name: 'stats', params: [OPTIONS], doc: 'Returns storage and index statistics.' },
];

/** The method with this name, or undefined when the table does not describe it. */
export function findMethod(name: string): MethodEntry | undefined {
  return COLLECTION_METHODS.find((method) => method.name === name);
}

/** The operator with this name, or undefined when the table does not describe it. */
export function findOperator(name: string): OperatorEntry | undefined {
  return QUERY_OPERATORS.find((operator) => operator.name === name);
}

/** The parameter list as shown in signature help, for example `find(filter, [projection])`. */
export function methodLabel(method: MethodEntry): string {
  const params = method.params.map((param) =>
    param.optional === true ? `[${param.name}]` : param.name,
  );
  return `${method.name}(${params.join(', ')})`;
}

export interface ConstructorEntry {
  readonly name: string;
  readonly doc: string;
  /** Snippet inserted for the constructor. `$1` is where the caret lands. */
  readonly snippet: string;
}

/** BSON constructors that mongosh accepts in a value position. */
export const BSON_CONSTRUCTORS: readonly ConstructorEntry[] = [
  {
    name: 'ISODate',
    doc: 'A date from an ISO 8601 string. Empty for now.',
    snippet: 'ISODate("$1")',
  },
  {
    name: 'ObjectId',
    doc: 'An ObjectId from 24 hex characters. Empty for a new id.',
    snippet: 'ObjectId("$1")',
  },
  {
    name: 'Date',
    doc: 'A date. As a constructor with new, otherwise a string.',
    snippet: 'new Date("$1")',
  },
  { name: 'Long', doc: 'A 64-bit integer from a string or number.', snippet: 'Long("$1")' },
  {
    name: 'NumberLong',
    doc: 'A 64-bit integer. The legacy name of Long.',
    snippet: 'NumberLong("$1")',
  },
  { name: 'Int32', doc: 'A 32-bit integer.', snippet: 'Int32($1)' },
  {
    name: 'NumberInt',
    doc: 'A 32-bit integer. The legacy name of Int32.',
    snippet: 'NumberInt($1)',
  },
  { name: 'Double', doc: 'A double from a number.', snippet: 'Double($1)' },
  { name: 'Decimal128', doc: 'A 128-bit decimal from a string.', snippet: 'Decimal128("$1")' },
  {
    name: 'NumberDecimal',
    doc: 'A 128-bit decimal. The legacy name of Decimal128.',
    snippet: 'NumberDecimal("$1")',
  },
  { name: 'UUID', doc: 'A UUID from its string form. Empty for a new one.', snippet: 'UUID("$1")' },
  {
    name: 'Timestamp',
    doc: 'An internal timestamp from seconds and an increment.',
    snippet: 'Timestamp({ t: $1, i: 1 })',
  },
  {
    name: 'BinData',
    doc: 'Binary data from a subtype and base64 text.',
    snippet: 'BinData(0, "$1")',
  },
  {
    name: 'RegExp',
    doc: 'A regular expression from a pattern and flags.',
    snippet: 'RegExp("$1")',
  },
  { name: 'MinKey', doc: 'Sorts before every other value.', snippet: 'MinKey()' },
  { name: 'MaxKey', doc: 'Sorts after every other value.', snippet: 'MaxKey()' },
  {
    name: 'DBRef',
    doc: 'A reference to a document in another collection.',
    snippet: 'DBRef("$1", ObjectId(""))',
  },
];

/** Methods of the cursor that find and aggregate return, in the order they usually chain. */
export const CURSOR_METHODS: readonly MethodEntry[] = [
  {
    name: 'sort',
    params: [{ name: 'spec' }],
    doc: 'Orders the documents. 1 ascending, -1 descending.',
  },
  { name: 'limit', params: [{ name: 'count' }], doc: 'Returns at most this many documents.' },
  { name: 'skip', params: [{ name: 'count' }], doc: 'Skips this many documents first.' },
  { name: 'project', params: [{ name: 'spec' }], doc: 'Keeps or drops fields. 1 keeps, 0 drops.' },
  { name: 'count', params: [], doc: 'The number of documents the cursor would return.' },
  { name: 'toArray', params: [], doc: 'Reads every document into an array.' },
  { name: 'forEach', params: [{ name: 'callback' }], doc: 'Runs a function on each document.' },
  { name: 'map', params: [{ name: 'callback' }], doc: 'Maps each document through a function.' },
  { name: 'hint', params: [{ name: 'index' }], doc: 'Forces an index by name or key spec.' },
  { name: 'collation', params: [{ name: 'collation' }], doc: 'Compares strings with a locale.' },
  {
    name: 'explain',
    params: [{ name: 'verbosity', optional: true }],
    doc: 'The plan instead of the documents.',
  },
  { name: 'batchSize', params: [{ name: 'size' }], doc: 'Documents per batch from the server.' },
  {
    name: 'maxTimeMS',
    params: [{ name: 'ms' }],
    doc: 'Fails the query after this many milliseconds.',
  },
  {
    name: 'allowDiskUse',
    params: [{ name: 'allow', optional: true }],
    doc: 'Lets a sort spill to disk.',
  },
  {
    name: 'comment',
    params: [{ name: 'text' }],
    doc: 'Tags the query in the logs and the profiler.',
  },
  { name: 'min', params: [{ name: 'spec' }], doc: 'Lower index bound, inclusive.' },
  { name: 'max', params: [{ name: 'spec' }], doc: 'Upper index bound, exclusive.' },
  { name: 'returnKey', params: [], doc: 'Returns only the index keys.' },
  { name: 'showRecordId', params: [], doc: 'Adds the record id to each document.' },
  { name: 'readPref', params: [{ name: 'mode' }], doc: 'The read preference for this cursor.' },
  { name: 'tailable', params: [], doc: 'Keeps the cursor open on a capped collection.' },
  { name: 'noCursorTimeout', params: [], doc: 'Keeps the server from closing an idle cursor.' },
  { name: 'pretty', params: [], doc: 'Formats the output. Has no effect in this app.' },
  { name: 'hasNext', params: [], doc: 'True when another document is available.' },
  { name: 'next', params: [], doc: 'The next document.' },
  { name: 'itcount', params: [], doc: 'Iterates the cursor and counts the documents.' },
  { name: 'size', params: [], doc: 'The count after skip and limit.' },
  { name: 'close', params: [], doc: 'Closes the cursor on the server.' },
];
