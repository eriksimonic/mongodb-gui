import {
  ARRAY_ELEMENT_FIELD,
  CONDITION_OPERATORS,
  type ConditionOperator,
  type FieldInfo,
  formatMongoshSyntax,
  type QueryCondition,
  type QueryGroup,
  type QueryItem,
  type ValueCondition,
  operatorsForTypes,
} from '@mongo-gui/core';
import { defaultValueOf, NEW_REGEX_PATTERN, valueTypeOf, type ValueType } from './value-types';

/** The BSON type names of a field, or no names when the field is not in the list. */
export function typesOf(fields: readonly FieldInfo[], field: string): readonly string[] {
  return fields.find((info) => info.path === field)?.types ?? [];
}

/** The value type a row of an operator takes for a field with the given BSON types. */
export function valueTypeFor(operator: ConditionOperator, types: readonly string[]): ValueType {
  switch (operator) {
    case 'in':
    case 'nin':
    case 'all':
      return 'List';
    case 'exists':
      return 'Boolean';
    case 'regex':
      return 'Regex';
    case 'size':
      return 'Number';
    default:
      return valueTypeOf(types);
  }
}

/**
 * The operators a condition can use. An unknown field offers every operator. A condition in a
 * scalar `$elemMatch` group offers no `elemMatch`, and no operator that another condition of the
 * group already uses, because the emitter drops a repeated operator.
 */
export function operatorsFor(
  fields: readonly FieldInfo[],
  field: string,
  scalarElement: boolean,
  taken: readonly ConditionOperator[],
): readonly ConditionOperator[] {
  const info = fields.find((candidate) => candidate.path === field);
  const all = info === undefined ? CONDITION_OPERATORS : operatorsForTypes(info.types);
  if (!scalarElement) {
    return all;
  }
  return all.filter((operator) => operator !== 'elemMatch' && !taken.includes(operator));
}

/** The fields and the scalar flag of the group of an `$elemMatch` on `field`. */
export function elemMatchScope(
  fields: readonly FieldInfo[],
  field: string,
  items: readonly QueryItem[],
): { readonly scalarElement: boolean; readonly fields: readonly FieldInfo[] } {
  const prefix = `${field}.`;
  const children = fields
    .filter((info) => info.path.startsWith(prefix))
    .map((info) => ({ path: info.path.slice(prefix.length), types: info.types }));
  const elementTypes = typesOf(fields, field).filter((type) => type !== 'Array');
  const hasElementCondition = items.some(
    (item) => item.kind === 'condition' && item.field === ARRAY_ELEMENT_FIELD,
  );
  // An array of scalars has a known element type and no child fields.
  const scalar =
    hasElementCondition || (items.length === 0 && children.length === 0 && elementTypes.length > 0);
  if (scalar) {
    return { scalarElement: true, fields: [{ path: ARRAY_ELEMENT_FIELD, types: elementTypes }] };
  }
  return { scalarElement: false, fields: children };
}

/** The group a new `$elemMatch` on `field` starts with. */
function newElemMatchGroup(fields: readonly FieldInfo[], field: string): QueryGroup {
  const scope = elemMatchScope(fields, field, []);
  if (!scope.scalarElement) {
    return { kind: 'group', operator: 'and', items: [] };
  }
  const first: ValueCondition = {
    kind: 'condition',
    enabled: true,
    field: ARRAY_ELEMENT_FIELD,
    operator: 'eq',
    value: '',
  };
  return {
    kind: 'group',
    operator: 'and',
    items: [conditionFor(first, ARRAY_ELEMENT_FIELD, 'eq', scope.fields, false)],
  };
}

/**
 * The condition with a new field and operator. It keeps the enabled flag. It keeps the value
 * when `keepValue` is true and the value still fits, otherwise it starts with the default value
 * of the operator. An `$elemMatch` keeps its group when the operator stays `$elemMatch`.
 */
export function conditionFor(
  current: QueryCondition,
  field: string,
  operator: ConditionOperator,
  fields: readonly FieldInfo[],
  keepValue: boolean,
): QueryCondition {
  const base = { kind: 'condition' as const, enabled: current.enabled, field };
  if (operator === 'elemMatch') {
    const group =
      current.operator === 'elemMatch' ? current.group : newElemMatchGroup(fields, field);
    return { ...base, operator, group };
  }
  if (operator === 'regex') {
    if (keepValue && current.operator === 'regex') {
      return { ...base, operator, pattern: current.pattern, options: current.options };
    }
    return { ...base, operator, pattern: NEW_REGEX_PATTERN, options: '' };
  }
  if (keepValue && current.operator !== 'regex' && current.operator !== 'elemMatch') {
    return { ...base, operator, value: current.value };
  }
  const valueType = valueTypeFor(operator, typesOf(fields, field));
  const value = operator === 'exists' ? true : defaultValueOf(valueType);
  return { ...base, operator, value };
}

/**
 * The condition a new row starts with. Outside a scalar `$elemMatch` group it has no field. Inside
 * one it uses the first operator the group still allows. It returns undefined when no operator is
 * left.
 */
export function newCondition(
  fields: readonly FieldInfo[],
  scalarElement: boolean,
  taken: readonly ConditionOperator[],
): QueryCondition | undefined {
  const empty: ValueCondition = {
    kind: 'condition',
    enabled: true,
    field: '',
    operator: 'eq',
    value: '',
  };
  if (!scalarElement) {
    return empty;
  }
  const operator = operatorsFor(fields, ARRAY_ELEMENT_FIELD, true, taken)[0];
  if (operator === undefined) {
    return undefined;
  }
  return conditionFor(
    { ...empty, field: ARRAY_ELEMENT_FIELD },
    ARRAY_ELEMENT_FIELD,
    operator,
    fields,
    false,
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The pattern and options of a `$regularExpression` value, or undefined for any other value. */
export function regexValueOf(value: unknown): { pattern: string; options: string } | undefined {
  if (!isRecord(value) || !isRecord(value.$regularExpression)) {
    return undefined;
  }
  const { pattern, options } = value.$regularExpression;
  return typeof pattern === 'string' && typeof options === 'string'
    ? { pattern, options }
    : undefined;
}

/** A value as one line of mongosh text, such as `{$gt: 5}` or `/ab/i`. */
export function mongoshText(value: unknown): string {
  return formatMongoshSyntax(JSON.stringify(value), { indent: 0 });
}

/**
 * The value type a stored EJSON value is shown with. The value input shows a value only in the type
 * of its own shape, so the type follows the shape. A plain string is a String.
 */
export function valueTypeOfValue(value: unknown): ValueType {
  if (value === null) return 'Null';
  if (typeof value === 'boolean') return 'Boolean';
  if (typeof value === 'number') return 'Number';
  if (Array.isArray(value)) return 'List';
  if (isRecord(value)) {
    if (typeof value.$oid === 'string') return 'ObjectId';
    if (typeof value.$date === 'string') return 'Date';
    if (isRecord(value.$regularExpression)) return 'Regex';
  }
  return 'String';
}
