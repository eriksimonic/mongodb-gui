/**
 * The condition operators a field offers in the builder. The input is the BSON type names of the
 * field from the schema sample. A field with several types gets the union of their operators.
 * The result keeps the order of `CONDITION_OPERATORS`.
 */

import { CONDITION_OPERATORS, type ConditionOperator } from './model';

const COMMON: readonly ConditionOperator[] = ['eq', 'ne', 'in', 'nin', 'exists', 'type'];
const ORDERED: readonly ConditionOperator[] = ['gt', 'gte', 'lt', 'lte'];
const ARRAY: readonly ConditionOperator[] = ['size', 'all', 'elemMatch'];

/** The operators each BSON type adds to the common set. A type not listed adds nothing. */
const EXTRA_BY_TYPE = new Map<string, readonly ConditionOperator[]>([
  ['String', [...ORDERED, 'regex']],
  ['Int32', ORDERED],
  ['Long', ORDERED],
  ['Double', ORDERED],
  ['Decimal128', ORDERED],
  ['Date', ORDERED],
  ['Array', ARRAY],
]);

export function operatorsForTypes(types: readonly string[]): readonly ConditionOperator[] {
  const allowed = new Set<ConditionOperator>(COMMON);
  for (const type of types) {
    for (const operator of EXTRA_BY_TYPE.get(type) ?? []) {
      allowed.add(operator);
    }
  }
  return CONDITION_OPERATORS.filter((operator) => allowed.has(operator));
}
