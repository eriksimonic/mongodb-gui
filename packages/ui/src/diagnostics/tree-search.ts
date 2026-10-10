/**
 * A node's position in the tree, as the keys from the root. The keys stay whole, so a key that
 * holds a dot is one segment.
 */
export type PathSegments = readonly string[];

/** The identity of a node. JSON of the segments cannot collide, whatever the keys contain. */
export function pathKey(segments: PathSegments): string {
  return JSON.stringify(segments);
}

/**
 * The nodes a search keeps visible, by pathKey. A node matches when its dotted text contains the
 * query, case-insensitive. Every ancestor of a match stays visible too. An empty query returns
 * undefined, which means "no filter".
 */
export function matchingPaths(value: unknown, query: string): ReadonlySet<string> | undefined {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return undefined;
  }
  const visible = new Set<string>();
  collect(value, [], needle, visible);
  return visible;
}

/** Returns true when the subtree at this path has a match. Adds the path and its matches to out. */
function collect(
  value: unknown,
  segments: PathSegments,
  needle: string,
  out: Set<string>,
): boolean {
  let hit = segments.length > 0 && segments.join('.').toLowerCase().includes(needle);
  for (const [key, child] of childEntries(value)) {
    if (collect(child, [...segments, key], needle, out)) {
      hit = true;
    }
  }
  if (hit && segments.length > 0) {
    out.add(pathKey(segments));
  }
  return hit;
}

/** The keys and values of an object or array. An array's keys are its indexes. Scalars have none. */
export function childEntries(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) {
    return value.map((item: unknown, index) => [String(index), item]);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value);
  }
  return [];
}

/** The value at a path of keys. Undefined when the path does not exist. */
export function valueAtPath(value: unknown, segments: PathSegments): unknown {
  let current: unknown = value;
  for (const segment of segments) {
    const found = childEntries(current).find(([key]) => key === segment);
    if (found === undefined) {
      return undefined;
    }
    current = found[1];
  }
  return current;
}
