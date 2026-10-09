import { BSON } from 'mongodb';

/**
 * Converts a driver value to plain JSON in canonical extended JSON form: ObjectId becomes
 * `{ "$oid": ... }`, dates become `{ "$date": ... }`, and so on. Structured clone over IPC
 * loses the BSON classes, so values cross the boundary in this form. Returns undefined for a
 * value the serialiser cannot represent.
 */
export function toCanonicalEjson(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  try {
    const text = BSON.EJSON.stringify(value, { relaxed: false });
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
