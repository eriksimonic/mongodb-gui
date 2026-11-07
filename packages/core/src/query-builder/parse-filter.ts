/**
 * Reads a find filter object into the filter tree of the query builder. It is the inverse of
 * `filterToEjson` in `emit-filter.ts`. Values stay canonical EJSON. Anything the model cannot show
 * becomes a raw item, so the emitter writes it back unchanged.
 */

import {
  ARRAY_ELEMENT_FIELD,
  CONDITION_OPERATORS,
  type ConditionOperator,
  GROUP_OPERATORS,
  type GroupOperator,
  type QueryGroup,
  type QueryItem,
} from './model';

type Plain = Record<string, unknown>;
type ValueOperator = Exclude<ConditionOperator, 'regex' | 'elemMatch'>;

const VALUE_OPERATORS = CONDITION_OPERATORS.filter(
  (operator): operator is ValueOperator => operator !== 'regex' && operator !== 'elemMatch',
);

/** The keys of canonical EJSON wrappers. A one-key object with one of these is a value. */
const EJSON_WRAPPERS = new Set([
  '$oid',
  '$date',
  '$numberInt',
  '$numberLong',
  '$numberDouble',
  '$numberDecimal',
  '$regularExpression',
  '$timestamp',
  '$binary',
  '$uuid',
  '$minKey',
  '$maxKey',
  '$symbol',
  '$code',
]);

/** The filter object of a find statement. Its top-level keys are an implicit AND group. */
export function filterFromEjson(filter: Plain): QueryGroup {
  return { kind: 'group', operator: 'and', items: filterItems(filter) };
}

function filterItems(filter: Plain): QueryItem[] {
  return Object.entries(filter).flatMap(([key, value]) => keyItems(key, value));
}

/** One top-level key. A logical key with a non-empty array of objects becomes a group. */
function keyItems(key: string, value: unknown): QueryItem[] {
  const operator = groupOperatorOf(key);
  if (operator !== undefined && isObjectArray(value)) {
    // The emitter splits the items of an AND group into `$and` arrays, so `$and` children join
    // the enclosing group.
    return operator === 'and'
      ? value.flatMap(filterItems)
      : [{ kind: 'group', operator, items: value.map(filterFromEjson) }];
  }
  if (key.startsWith('$')) {
    return [{ kind: 'rawFragment', enabled: true, key, value }];
  }
  return fieldItems(key, value);
}

function groupOperatorOf(key: string): GroupOperator | undefined {
  return GROUP_OPERATORS.find((operator) => `$${operator}` === key);
}

/** The items of one field. A plain value is an `eq`. An operator object gives one item per key. */
function fieldItems(field: string, value: unknown): QueryItem[] {
  if (isOperatorObject(value)) {
    return operatorItems(field, value);
  }
  return [{ kind: 'condition', enabled: true, field, operator: 'eq', value }];
}

/** The items of an operator object, in key order. `$regex` takes its `$options` with it. */
function operatorItems(field: string, operators: Plain): QueryItem[] {
  const pattern = operators.$regex;
  const options = operators.$options;
  const paired =
    typeof pattern === 'string' && (options === undefined || typeof options === 'string');
  return Object.entries(operators).flatMap(([key, operand]): QueryItem[] => {
    if (paired && key === '$options') {
      return [];
    }
    if (paired && key === '$regex') {
      return [
        {
          kind: 'condition',
          enabled: true,
          field,
          operator: 'regex',
          pattern,
          options: typeof options === 'string' ? options : '',
        },
      ];
    }
    if (key === '$elemMatch' && isPlainObject(operand)) {
      return [
        {
          kind: 'condition',
          enabled: true,
          field,
          operator: 'elemMatch',
          group: elemMatchGroup(operand),
        },
      ];
    }
    const operator = VALUE_OPERATORS.find((name) => `$${name}` === key);
    if (operator !== undefined) {
      return [{ kind: 'condition', enabled: true, field, operator, value: operand }];
    }
    return [{ kind: 'rawCondition', enabled: true, field, operator: key, value: operand }];
  });
}

/**
 * The group of an `$elemMatch`. A body with a `$` key that is not a logical operator is the scalar
 * form, on the array element. Any other body is a filter over the fields of each element.
 */
function elemMatchGroup(value: Plain): QueryGroup {
  const scalar = Object.keys(value).some(
    (key) => key.startsWith('$') && groupOperatorOf(key) === undefined,
  );
  if (scalar) {
    return { kind: 'group', operator: 'and', items: operatorItems(ARRAY_ELEMENT_FIELD, value) };
  }
  return filterFromEjson(value);
}

export function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isObjectArray(value: unknown): value is Plain[] {
  return Array.isArray(value) && value.length > 0 && value.every(isPlainObject);
}

/** An object whose keys all start with `$`, such as `{ $gt: 1 }`. An EJSON wrapper is not one. */
export function isOperatorObject(value: unknown): value is Plain {
  if (!isPlainObject(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 1 && EJSON_WRAPPERS.has(keys[0] ?? '')) {
    return false;
  }
  return keys.length > 0 && keys.every((key) => key.startsWith('$'));
}
