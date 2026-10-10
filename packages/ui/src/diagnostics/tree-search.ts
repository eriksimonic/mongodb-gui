/**
 * The paths a search keeps visible in a document tree. A path matches when its dotted text
 * contains the query, case-insensitive. Every ancestor of a match stays visible too, so the match
 * can be reached. An empty query returns undefined, which means "no filter".
 */
export function matchingPaths(value: unknown, query: string): ReadonlySet<string> | undefined {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return undefined;
  }
  const visible = new Set<string>();
  collect(value, '', needle, visible);
  return visible;
}

/** Returns true when the subtree at this path has a match. Adds the path and its matches to out. */
function collect(value: unknown, path: string, needle: string, out: Set<string>): boolean {
  const children = childEntries(value);
  let hit = path !== '' && path.toLowerCase().includes(needle);
  for (const [key, child] of children) {
    const childPath = path === '' ? key : `${path}.${key}`;
    if (collect(child, childPath, needle, out)) {
      hit = true;
    }
  }
  if (hit && path !== '') {
    out.add(path);
  }
  return hit;
}

/** The keys and values of an object or array. Scalars have none. */
export function childEntries(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) {
    return value.map((item: unknown, index) => [`[${index}]`, item]);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value);
  }
  return [];
}

/** The value at a dotted path, as the tree builds the path. Undefined when the path is absent. */
export function valueAtPath(value: unknown, path: string): unknown {
  if (path === '') {
    return value;
  }
  let current: unknown = value;
  for (const segment of path.split('.')) {
    const entries = childEntries(current);
    const found = entries.find(([key]) => key === segment);
    if (found === undefined) {
      return undefined;
    }
    current = found[1];
  }
  return current;
}
