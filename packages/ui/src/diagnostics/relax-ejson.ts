/**
 * The value of a canonical EJSON document as a reader expects it: numbers as plain numbers, dates as
 * ISO text. Other wrappers, such as $oid, stay as they are. The input is not changed.
 */
export function relaxEjson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => relaxEjson(item));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const entries = Object.entries(value);
  if (entries.length === 1) {
    const [key, inner] = entries[0] ?? ['', undefined];
    const number = numberOf(key, inner);
    if (number !== undefined) {
      return number;
    }
    if (key === '$date') {
      const millis = dateMillis(inner);
      if (millis !== undefined) {
        return new Date(millis).toISOString();
      }
    }
  }
  return Object.fromEntries(entries.map(([key, item]) => [key, relaxEjson(item)]));
}

function numberOf(key: string, inner: unknown): number | undefined {
  if (key === '$numberInt' || key === '$numberLong' || key === '$numberDouble') {
    return typeof inner === 'string' ? Number(inner) : undefined;
  }
  return undefined;
}

function dateMillis(inner: unknown): number | undefined {
  if (typeof inner === 'string') {
    const millis = Date.parse(inner);
    return Number.isNaN(millis) ? undefined : millis;
  }
  if (typeof inner === 'object' && inner !== null && '$numberLong' in inner) {
    const millis = Number(inner.$numberLong);
    return Number.isFinite(millis) ? millis : undefined;
  }
  return undefined;
}
