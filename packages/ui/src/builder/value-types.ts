/** The value types the builder offers. The order is the order of the type menu. */
export const VALUE_TYPES = [
  'String',
  'Number',
  'Boolean',
  'Null',
  'Date',
  'ObjectId',
  'Regex',
  'List',
] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

/** The value type of each BSON type name the schema sample and the validator use. */
const VALUE_TYPE_OF_BSON: ReadonlyMap<string, ValueType> = new Map<string, ValueType>([
  ['String', 'String'],
  ['Int32', 'Number'],
  ['Long', 'Number'],
  ['Double', 'Number'],
  ['Decimal128', 'Number'],
  ['Boolean', 'Boolean'],
  ['Null', 'Null'],
  ['Date', 'Date'],
  ['ObjectId', 'ObjectId'],
  ['Regex', 'Regex'],
  ['Array', 'List'],
]);

/**
 * The value type of a field from its BSON type names. The first name that has a value type wins,
 * in the order the field lists them. Null is the last choice, so a nullable field gets the type of
 * its value. A field with no such name gets String.
 */
export function valueTypeOf(types: readonly string[]): ValueType {
  for (const type of types) {
    const valueType = type === 'Null' ? undefined : VALUE_TYPE_OF_BSON.get(type);
    if (valueType !== undefined) {
      return valueType;
    }
  }
  return types.includes('Null') ? 'Null' : 'String';
}

/**
 * The pattern a new regex starts with. An empty pattern would be written `//`, which mongosh reads
 * as a comment, so the new pattern is the JavaScript source of an empty RegExp.
 */
export const NEW_REGEX_PATTERN = '(?:)';

/** The value a new row of a type starts with. Each value is valid for its type. */
export function defaultValueOf(type: ValueType): unknown {
  switch (type) {
    case 'String':
      return '';
    case 'Number':
      return 0;
    case 'Boolean':
      return false;
    case 'Null':
      return null;
    case 'Date':
      return { $date: new Date().toISOString() };
    case 'ObjectId':
      return { $oid: '0'.repeat(24) };
    case 'Regex':
      return { $regularExpression: { pattern: NEW_REGEX_PATTERN, options: '' } };
    case 'List':
      return [];
  }
}
