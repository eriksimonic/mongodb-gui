const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/**
 * Wraps plain JavaScript values in canonical extended JSON, the form the main process sends for
 * BSON values. Used by the browser mock so its rows match what Electron returns. Integers become
 * $numberInt or $numberLong, other numbers $numberDouble, and dates $date.
 */
export function toCanonicalValue(value: unknown): unknown {
  if (value instanceof Date) {
    return { $date: { $numberLong: String(value.getTime()) } };
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => toCanonicalValue(item));
  }
  if (typeof value === 'number') {
    return canonicalNumber(value);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = toCanonicalValue(item);
    }
    return out;
  }
  return value;
}

function canonicalNumber(value: number): Record<string, string> {
  if (!Number.isInteger(value)) {
    return { $numberDouble: String(value) };
  }
  if (value >= INT32_MIN && value <= INT32_MAX) {
    return { $numberInt: String(value) };
  }
  return { $numberLong: String(value) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
