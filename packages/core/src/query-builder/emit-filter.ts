/**
 * Turns the filter tree of the query builder into a find filter. An `and` group merges into its
 * parent object, so a nested `and` is flattened. An `or` or `nor` group becomes an array under its
 * operator, with one object per element. Disabled items are left out, and a group with no live
 * items is dropped.
 */

import { formatMongoshSyntax } from '../ejson/format';
import { isOperatorObject } from './parse-filter';
import {
  ARRAY_ELEMENT_FIELD,
  type QueryCondition,
  type QueryGroup,
  type QueryItem,
  type RawCondition,
} from './model';

type Plain = Record<string, unknown>;

/** A new object with no prototype, so a field named `__proto__` is an ordinary key. */
function emptyObject(): Plain {
  return Object.create(null) as Plain;
}

/** The filter as canonical EJSON. */
export function filterToEjson(group: QueryGroup): Plain {
  return groupObject(group);
}

/** The filter as mongosh source, indented two spaces. */
export function emitFilter(group: QueryGroup): string {
  return formatMongoshSyntax(JSON.stringify(filterToEjson(group)), { indent: 2 });
}

/** True when the item is enabled, or a group with at least one enabled item. */
function hasLive(item: QueryItem): boolean {
  return item.kind === 'group' ? item.items.some(hasLive) : item.enabled;
}

/** The live items joined by AND. A nested `and` group is flattened into its parent. */
function liveAndItems(items: readonly QueryItem[]): QueryItem[] {
  return items
    .filter(hasLive)
    .flatMap((item) =>
      item.kind === 'group' && item.operator === 'and' ? liveAndItems(item.items) : [item],
    );
}

function groupObject(group: QueryGroup): Plain {
  if (group.operator === 'and') {
    return andObject(group.items);
  }
  const list = elements(group.items);
  return list.length === 0 ? emptyObject() : { [`$${group.operator}`]: list };
}

/** The array elements of an `$or` or `$nor`. Each element is one object. */
function elements(items: readonly QueryItem[]): Plain[] {
  return items
    .filter(hasLive)
    .map((item) => (item.kind === 'group' ? groupObject(item) : andObject([item])));
}

/**
 * Items joined by AND as one object. Two operators on one field share one operator object. A
 * unit that repeats a key already in the object goes into a `$and` array beside the object.
 */
function andObject(items: readonly QueryItem[]): Plain {
  const live = liveAndItems(items);
  const counts = countFields(live);
  const out = emptyObject();
  const overflow: Plain[] = [];
  const fieldOperators = new Map<string, Plain>();

  for (const item of live) {
    if (item.kind === 'group') {
      place(out, overflow, `$${item.operator}`, elements(item.items));
    } else if (item.kind === 'rawFragment') {
      place(out, overflow, item.key, item.value);
    } else if (
      item.kind === 'condition' &&
      item.operator === 'eq' &&
      counts.get(item.field) === 1 &&
      !isOperatorObject(item.value)
    ) {
      place(out, overflow, item.field, item.value);
    } else {
      let operators = fieldOperators.get(item.field);
      if (operators === undefined) {
        operators = emptyObject();
        fieldOperators.set(item.field, operators);
        place(out, overflow, item.field, operators);
      }
      // A regex unit holds `$regex` and `$options`. It moves to `$and` whole, so its options stay.
      const unit = operatorsOf(item);
      if (Object.keys(unit).some((key) => key in operators)) {
        overflow.push({ [item.field]: unit });
      } else {
        Object.assign(operators, unit);
      }
    }
  }

  if (overflow.length > 0) {
    out.$and = overflow;
  }
  return out;
}

/**
 * The body of an `$elemMatch` on the elements of a scalar array, such as `{ $elemMatch: { $gt: 1 } }`.
 * It keeps the first condition of each operator and skips nested groups. The builder UI (task U3)
 * must not offer repeated operators or nested groups in this form, so `$and`, `$or` and `$nor`
 * never appear in it. The operator of the body group is not written, so the UI must not offer
 * an `or` body either.
 */
function scalarObject(items: readonly QueryItem[]): Plain {
  const out = emptyObject();
  for (const item of items.filter(hasLive)) {
    if (
      item.kind === 'group' ||
      item.kind === 'rawFragment' ||
      item.field !== ARRAY_ELEMENT_FIELD
    ) {
      continue;
    }
    const unit = operatorsOf(item);
    if (!Object.keys(unit).some((key) => key in out)) {
      Object.assign(out, unit);
    }
  }
  return out;
}

/** True when a group holds a condition on the array element, at any depth. */
function isScalarBody(items: readonly QueryItem[]): boolean {
  return items
    .filter(hasLive)
    .some((item) =>
      item.kind === 'group'
        ? isScalarBody(item.items)
        : item.kind !== 'rawFragment' && item.field === ARRAY_ELEMENT_FIELD,
    );
}

/** Counts the operators on each field. A field with one `eq` is written as a plain value. */
function countFields(items: readonly QueryItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (
      (item.kind === 'condition' || item.kind === 'rawCondition') &&
      item.field !== ARRAY_ELEMENT_FIELD
    ) {
      counts.set(item.field, (counts.get(item.field) ?? 0) + 1);
    }
  }
  return counts;
}

/** Puts a key into the object, or into `overflow` as its own object when the key is taken. */
function place(out: Plain, overflow: Plain[], key: string, value: unknown): void {
  if (key in out) {
    overflow.push({ [key]: value });
  } else {
    out[key] = value;
  }
}

/** The operator entries of one condition. An `eq` is `$eq` here, the plain form is chosen above. */
function operatorsOf(item: QueryCondition | RawCondition): Plain {
  if (item.kind === 'rawCondition') {
    return { [item.operator]: item.value };
  }
  if (item.operator === 'regex') {
    return item.options === ''
      ? { $regex: item.pattern }
      : { $regex: item.pattern, $options: item.options };
  }
  if (item.operator === 'elemMatch') {
    // An empty body writes `{ $elemMatch: {} }`, which the parser reads back as an empty group.
    return {
      $elemMatch: isScalarBody(item.group.items)
        ? scalarObject(item.group.items)
        : groupObject(item.group),
    };
  }
  return { [`$${item.operator}`]: item.value };
}
