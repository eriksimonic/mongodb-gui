// Bounded previews of result documents. The shell runtime builds them and the UI reads them, so
// both share this module. A preview is the plain JSON tree of a canonical EJSON document in which
// an oversized value is replaced by a marker. Every value that is not a marker is exact.

export const TRUNCATED_KEY = '$mgTruncated';
/** A document at or under this many characters of EJSON is sent whole. */
export const DOC_PREVIEW_CHARS = 16_384;
/** The preview text one response carries for all of its documents. */
export const BATCH_PREVIEW_CHARS = 2 * 1024 * 1024;
export const MIN_DOC_PREVIEW_CHARS = 1024;
export const STRING_HEAD_CHARS = 256;
export const ROOT_KEY_LIMIT = 2000;
export const PREVIEW_MAX_DEPTH = 6;
/** A root _id up to this many characters is kept as it is. */
export const ID_KEEP_CHARS = 16_384;

const MARKER_COST = 48;
const MIN_STRING_HEAD = 32;
const MIN_CONTAINER_SHARE = 1024;
const BINARY_KEEP_CHARS = 1024;
const TRUNCATED_TYPES: readonly string[] = ['string', 'array', 'object', 'binary'];

export type TruncatedType = 'string' | 'array' | 'object' | 'binary';

/**
 * The root marker of a previewed document. ref is absent when the full text was not stored. edits
 * are the field changes saved since the preview was made. The stored text does not hold them, so
 * whoever reads it applies them in order.
 */
export interface PreviewInfo {
  readonly ref: string | undefined;
  readonly chars: number;
  readonly edits?: readonly PreviewEdit[];
}

/** One saved change to a field of a previewed document: a `$set` of value, or a `$unset`. */
export interface PreviewEdit {
  readonly path: string;
  readonly unset?: true;
  readonly value?: unknown;
}

/** Replaces one oversized value. n is its length, key count or byte length. */
export interface NestedMarker {
  readonly t: TruncatedType;
  readonly n: number;
  readonly head?: unknown;
}

type Tree = Record<string, unknown>;

interface Budget {
  left: number;
  cut: boolean;
}

/** The preview size for the next document, given what the response used and the documents still to come. */
export function docBudget(used: number, docsLeft: number): number {
  const share = Math.floor((BATCH_PREVIEW_CHARS - used) / Math.max(1, docsLeft));
  return Math.min(DOC_PREVIEW_CHARS, Math.max(MIN_DOC_PREVIEW_CHARS, share));
}

/**
 * Cuts a document tree to about budget characters of JSON. The caller sends the original text when
 * it fits, so this is only for oversized documents. The input is not changed.
 */
export function previewDocument(tree: Tree, budget: number): { value: Tree; cut: boolean } {
  const state: Budget = { left: budget, cut: false };
  const value: Tree = {};
  const keys = Object.keys(tree);
  keys.slice(0, ROOT_KEY_LIMIT).forEach((key) => {
    const item = tree[key];
    // Once the budget is spent a key stays only as a marker, which is cheap and keeps the key
    // visible. A scalar or a wrapper is never cut, so it is left out instead. _id always stays.
    const spent = state.left <= 0 && key !== '_id';
    const kept = key === '_id' ? previewId(item, state) : previewValue(item, state, 1);
    if (spent && nestedMarker(kept) === undefined) {
      state.cut = true;
      return;
    }
    setOwn(value, key, kept);
    state.left -= key.length + 4;
  });
  if (keys.length > ROOT_KEY_LIMIT) {
    state.cut = true;
  }
  return { value, cut: state.cut };
}

export function withPreviewInfo(preview: Tree, info: PreviewInfo): Tree {
  const marker: Tree = { chars: info.chars };
  if (info.ref !== undefined) {
    marker['ref'] = info.ref;
  }
  if (info.edits !== undefined && info.edits.length > 0) {
    marker['edits'] = info.edits;
  }
  return { ...preview, [TRUNCATED_KEY]: marker };
}

export function previewInfo(doc: unknown): PreviewInfo | undefined {
  if (!isRecord(doc) || !Object.hasOwn(doc, TRUNCATED_KEY)) {
    return undefined;
  }
  const marker = doc[TRUNCATED_KEY];
  if (!isRecord(marker) || typeof marker['chars'] !== 'number') {
    return undefined;
  }
  const ref = marker['ref'];
  const edits = Array.isArray(marker['edits'])
    ? marker['edits'].filter(
        (edit): edit is PreviewEdit => isRecord(edit) && typeof edit['path'] === 'string',
      )
    : [];
  return {
    ref: typeof ref === 'string' ? ref : undefined,
    chars: marker['chars'],
    ...(edits.length === 0 ? {} : { edits }),
  };
}

/** A preview whose full text was not stored, so nothing can read the whole document back. */
export function isUnkeptPreview(doc: unknown): boolean {
  const info = previewInfo(doc);
  return info !== undefined && info.ref === undefined;
}

export function nestedMarker(value: unknown): NestedMarker | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== TRUNCATED_KEY) {
    return undefined;
  }
  const inner = value[TRUNCATED_KEY];
  if (!isRecord(inner) || typeof inner['t'] !== 'string' || typeof inner['n'] !== 'number') {
    return undefined;
  }
  if (!TRUNCATED_TYPES.includes(inner['t'])) {
    return undefined;
  }
  const t = inner['t'] as TruncatedType;
  return Object.hasOwn(inner, 'head')
    ? { t, n: inner['n'], head: inner['head'] }
    : { t, n: inner['n'] };
}

export function containsTruncatedMarker(text: string): boolean {
  return text.includes(TRUNCATED_KEY);
}

function isRecord(value: unknown): value is Tree {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A key named __proto__ must stay an own property of the copy.
function setOwn(target: Tree, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function marker(t: TruncatedType, n: number, head?: unknown): unknown {
  return {
    [TRUNCATED_KEY]: head === undefined ? { t, n } : { t, n, head },
  };
}

// A well-formed prefix: a cut never leaves half of a surrogate pair.
function stringHead(text: string, chars: number): string {
  const end = chars > 0 && isHighSurrogate(text.charCodeAt(chars - 1)) ? chars - 1 : chars;
  return text.slice(0, end);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function previewId(id: unknown, state: Budget): unknown {
  const size = JSON.stringify(id)?.length ?? 0;
  if (size <= ID_KEEP_CHARS) {
    state.left -= size;
    return id;
  }
  state.cut = true;
  state.left -= MARKER_COST;
  return emptyMarker(id);
}

// A marker for a value the budget has no room for. Only a string keeps a head.
function emptyMarker(value: unknown): unknown {
  if (typeof value === 'string') {
    const head = stringHead(value, STRING_HEAD_CHARS);
    return marker('string', value.length, head);
  }
  if (Array.isArray(value)) {
    return marker('array', value.length);
  }
  if (isRecord(value)) {
    return marker('object', Object.keys(value).length);
  }
  return value;
}

function previewValue(value: unknown, state: Budget, depth: number): unknown {
  if (typeof value === 'string') {
    return previewString(value, state);
  }
  if (Array.isArray(value)) {
    return previewArray(value, state, depth);
  }
  if (isRecord(value)) {
    return previewObject(value, state, depth);
  }
  state.left -= value === null || typeof value === 'boolean' ? 5 : String(value).length;
  return value;
}

function previewString(text: string, state: Budget): unknown {
  const cap = Math.min(STRING_HEAD_CHARS, Math.max(MIN_STRING_HEAD, Math.floor(state.left / 4)));
  if (text.length <= cap) {
    state.left -= text.length + 2;
    return text;
  }
  const head = stringHead(text, cap);
  state.cut = true;
  state.left -= head.length + MARKER_COST;
  return marker('string', text.length, head);
}

function base64Bytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

// An EJSON wrapper such as {$oid}, {$date} or {$numberLong} is one atomic value. Only a large
// binary, a long string-valued wrapper or any other wrapper over BINARY_KEEP_CHARS is cut. Returns undefined when the object is no wrapper.
function previewWrapper(value: Tree, state: Budget): { value: unknown } | undefined {
  const keys = Object.keys(value);
  const key = keys[0];
  if (keys.length !== 1 || key === undefined || !key.startsWith('$')) {
    return undefined;
  }
  const inner = value[key];
  if (key === '$binary' && isRecord(inner) && typeof inner['base64'] === 'string') {
    if (inner['base64'].length > BINARY_KEEP_CHARS) {
      state.cut = true;
      state.left -= MARKER_COST;
      return { value: marker('binary', base64Bytes(inner['base64'])) };
    }
  }
  if (typeof inner === 'string' && inner.length > BINARY_KEEP_CHARS) {
    // $code and $symbol carry text of any length. It is cut like any string.
    return undefined;
  }
  const size = JSON.stringify(value)?.length ?? 0;
  if (size > BINARY_KEEP_CHARS) {
    // A regular expression with a huge pattern, for one. The wrapper is one value, so it is cut whole.
    state.cut = true;
    state.left -= MARKER_COST;
    return { value: marker('object', 1) };
  }
  state.left -= size;
  return { value };
}

function previewArray(items: readonly unknown[], state: Budget, depth: number): unknown {
  if (items.length === 0) {
    state.left -= 2;
    return items;
  }
  if (depth > PREVIEW_MAX_DEPTH || state.left <= 0) {
    state.cut = true;
    state.left -= MARKER_COST;
    return marker('array', items.length);
  }
  const start = state.left;
  const share = Math.max(MIN_CONTAINER_SHARE, Math.floor(start / 2));
  const kept: unknown[] = [];
  let index = 0;
  while (index < items.length && state.left > 0 && start - state.left < share) {
    kept.push(previewValue(items[index], state, depth + 1));
    state.left -= 1;
    index += 1;
  }
  if (index === items.length) {
    return kept;
  }
  state.cut = true;
  state.left -= MARKER_COST;
  return marker('array', items.length, kept);
}

function previewObject(value: Tree, state: Budget, depth: number): unknown {
  const wrapper = previewWrapper(value, state);
  if (wrapper !== undefined) {
    return wrapper.value;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    state.left -= 2;
    return value;
  }
  if (depth > PREVIEW_MAX_DEPTH || state.left <= 0) {
    state.cut = true;
    state.left -= MARKER_COST;
    return marker('object', keys.length);
  }
  const start = state.left;
  const share = Math.max(MIN_CONTAINER_SHARE, Math.floor(start / 2));
  const kept: Tree = {};
  let index = 0;
  while (index < keys.length && state.left > 0 && start - state.left < share) {
    const key = keys[index] as string;
    state.left -= key.length + 4;
    setOwn(kept, key, previewValue(value[key], state, depth + 1));
    index += 1;
  }
  if (index === keys.length) {
    return kept;
  }
  state.cut = true;
  state.left -= MARKER_COST;
  return marker('object', keys.length, kept);
}
