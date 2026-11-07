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
 * in the order the field lists them. A field with no such name gets String.
 */
export function valueTypeOf(types: readonly string[]): ValueType {
  for (const type of types) {
    const valueType = VALUE_TYPE_OF_BSON.get(type);
    if (valueType !== undefined) {
      return valueType;
    }
  }
  return 'String';
}
