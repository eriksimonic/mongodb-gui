import { isPlainObject, type JsonObject } from './result-model';

/**
 * Returns a copy of the document with the value at a dotted path set. Missing objects along the
 * path are created. Array segments are indexes, as in the database's own dotted paths. A scalar in
 * the way leaves the document as it was.
 */
export function withValueAtPath(document: JsonObject, path: string, value: unknown): JsonObject {
  return asObject(setIn(document, path.split('.'), value), document);
}

/**
 * Returns a copy of the document without the value at a dotted path. An array element is set to
 * null, as `$unset` does on an element.
 */
export function withoutPath(document: JsonObject, path: string): JsonObject {
  return asObject(removeIn(document, path.split('.')), document);
}

function asObject(value: unknown, fallback: JsonObject): JsonObject {
  return isPlainObject(value) ? value : fallback;
}

function setIn(node: unknown, keys: readonly string[], value: unknown): unknown {
  const [key, ...rest] = keys;
  if (key === undefined) {
    return value;
  }
  if (Array.isArray(node)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= node.length) {
      return node;
    }
    const copy = [...node];
    copy[index] = setIn(node[index], rest, value);
    return copy;
  }
  if (node === undefined || isPlainObject(node)) {
    const base: JsonObject = node ?? {};
    return { ...base, [key]: setIn(base[key], rest, value) };
  }
  return node;
}

function removeIn(node: unknown, keys: readonly string[]): unknown {
  const [key, ...rest] = keys;
  if (key === undefined) {
    return node;
  }
  if (Array.isArray(node)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= node.length) {
      return node;
    }
    const copy = [...node];
    copy[index] = rest.length === 0 ? null : removeIn(node[index], rest);
    return copy;
  }
  if (!isPlainObject(node) || !(key in node)) {
    return node;
  }
  if (rest.length === 0) {
    return Object.fromEntries(Object.entries(node).filter(([name]) => name !== key));
  }
  return { ...node, [key]: removeIn(node[key], rest) };
}
