const ID_FIELD = '_id';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Top-level field names of raw EJSON documents, with `_id` removed. Used for field suggestions.
 * Text that is not a JSON object with an `_id` is skipped.
 */
export function topLevelKeys(documentEjsons: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const text of documentEjsons) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (isRecord(parsed) && ID_FIELD in parsed) {
      for (const key of Object.keys(parsed)) {
        if (key !== ID_FIELD) {
          keys.add(key);
        }
      }
    }
  }
  return [...keys].sort();
}
