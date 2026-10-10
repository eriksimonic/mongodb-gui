/**
 * The mongosh statement the translator produces, as a value tree. The emitter turns the tree into
 * editor text. Keeping a tree between the two lets tests compare structures instead of strings.
 */

/** Marks a value that is not plain JSON, such as a date or a regular expression. */
export const SPECIAL: unique symbol = Symbol('mongo-special');

export type MongoSpecial =
  /** Emitted as `ISODate('<iso>')`. */
  | { readonly [SPECIAL]: 'date'; readonly iso: string }
  /** Emitted as `new Date()`. */
  | { readonly [SPECIAL]: 'now' }
  /** Emitted as `ObjectId('<hex>')`. */
  | { readonly [SPECIAL]: 'objectId'; readonly hex: string }
  /** Emitted as a regex literal, `/<pattern>/<options>`. */
  | { readonly [SPECIAL]: 'regex'; readonly pattern: string; readonly options: string };

export type MongoValue =
  null | boolean | number | string | MongoSpecial | readonly MongoValue[] | MongoObject;

export interface MongoObject {
  readonly [key: string]: MongoValue;
}

export function mongoDate(iso: string): MongoSpecial {
  return { [SPECIAL]: 'date', iso };
}

export function mongoNow(): MongoSpecial {
  return { [SPECIAL]: 'now' };
}

export function mongoObjectId(hex: string): MongoSpecial {
  return { [SPECIAL]: 'objectId', hex };
}

export function mongoRegex(pattern: string, options: string): MongoSpecial {
  return { [SPECIAL]: 'regex', pattern, options };
}

export function isMongoSpecial(value: MongoValue): value is MongoSpecial {
  return typeof value === 'object' && value !== null && SPECIAL in value;
}

/** A method chained after `find`, in order. */
export interface MongoChainCall {
  readonly method: 'sort' | 'skip' | 'limit';
  readonly args: readonly MongoValue[];
}

/**
 * One collection method call, such as `db.orders.find({ a: 1 }, { b: 1 }).sort({ b: -1 }).limit(5)`
 * or `db.orders.aggregate([...])`. The emitter picks `db.<name>` or `db.getCollection('<name>')`.
 */
export interface MongoStatement {
  readonly collection: string;
  readonly method: 'find' | 'aggregate' | 'updateMany' | 'deleteMany' | 'insertMany';
  readonly args: readonly MongoValue[];
  /** Only `find` has a chain. The others leave it empty. */
  readonly chain: readonly MongoChainCall[];
  readonly kind: 'read' | 'write';
  /** A write whose filter matches every document, such as an UPDATE or DELETE without WHERE. */
  readonly unsafe: boolean;
}
