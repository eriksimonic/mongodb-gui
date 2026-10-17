import { AppErrorException, appError, previewInfo } from '@mongo-gui/core';
import { withValueAtPath, withoutPath } from './document-path';
import { isPlainObject, type JsonObject } from './result-model';
import { copyTextOf, exactCopyTextOf } from './tree-rows';

/** Copy refuses a selection whose text would be over this many characters. */
export const COPY_MAX_CHARS = 8 * 1024 * 1024;
/** A document over this many characters opens in the shell or an export, not in the dialog. */
export const OPEN_MAX_CHARS = 4 * 1024 * 1024;

type ReadFull = (ref: string) => Promise<string>;

/**
 * The full canonical EJSON text of a loaded document, which may be a preview. A preview is never
 * the answer: its text comes from the spill, with the field edits saved since applied on top.
 * Copy, the open dialog and export all need this.
 */
export async function fullDocumentText(doc: JsonObject, read: ReadFull): Promise<string> {
  const info = previewInfo(doc);
  if (info === undefined) {
    return JSON.stringify(doc);
  }
  if (info.ref === undefined) {
    throw new AppErrorException(
      appError('NOT_FOUND', 'The full document was not kept. Run the query again.'),
    );
  }
  const text = await read(info.ref);
  if (info.edits === undefined) {
    return text;
  }
  let full = JSON.parse(text) as JsonObject;
  for (const edit of info.edits) {
    full =
      edit.unset === true
        ? withoutPath(full, edit.path)
        : withValueAtPath(full, edit.path, edit.value);
  }
  return JSON.stringify(full);
}

/**
 * The full documents, parsed. The size is estimated before anything is read, from the sizes the
 * previews carry, so a selection that is too large fails without a read. Documents sent whole are
 * already loaded and cost nothing to read. Previewed documents are read one at a time.
 */
export async function fullDocuments(
  docs: readonly JsonObject[],
  read: ReadFull,
  limitChars: number,
): Promise<JsonObject[]> {
  let estimate = 0;
  for (const doc of docs) {
    estimate += previewInfo(doc)?.chars ?? 0;
  }
  if (estimate > limitChars) {
    throw new AppErrorException(appError('VALIDATION', 'Too large to copy. Use Export.'));
  }
  const full: JsonObject[] = [];
  for (const doc of docs) {
    if (previewInfo(doc) === undefined) {
      full.push(doc);
    } else {
      full.push(JSON.parse(await fullDocumentText(doc, read)) as JsonObject);
    }
  }
  return full;
}

/** The value at a dotted path, through objects and arrays. The empty path is the document. */
function fieldAt(doc: JsonObject, path: string): unknown {
  if (path === '') {
    return doc;
  }
  let current: unknown = doc;
  for (const key of path.split('.')) {
    if (!(Array.isArray(current) || isPlainObject(current)) || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * The copy text of one field. A value the preview shortened is taken from the full document, so the
 * copy holds all of it.
 */
export async function fullValueText(
  doc: JsonObject,
  path: string,
  value: unknown,
  read: ReadFull,
): Promise<string> {
  const exact = exactCopyTextOf(value);
  if (exact !== undefined) {
    return exact;
  }
  if (previewInfo(doc) === undefined) {
    throw new AppErrorException(appError('NOT_FOUND', 'The full value is not available.'));
  }
  const [full] = await fullDocuments([doc], read, COPY_MAX_CHARS);
  return copyTextOf(fieldAt(full ?? {}, path));
}
