import { GridFsFilenameSchema, type GridFsBucket, type GridFsFile } from '@mongo-gui/core';

const BINARY_UNIT = 1024;
const BINARY_UNITS = ['KiB', 'MiB', 'GiB', 'TiB'] as const;

/** Sizes with binary prefixes. Bytes stay whole, larger sizes get one decimal. */
export function formatBytes(bytes: number): string {
  if (bytes < BINARY_UNIT) {
    return `${bytes} B`;
  }
  let value = bytes / BINARY_UNIT;
  let unit = 0;
  while (value >= BINARY_UNIT && unit < BINARY_UNITS.length - 1) {
    value /= BINARY_UNIT;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BINARY_UNITS[unit] ?? 'TiB'}`;
}

/** The upload date in the local time zone, for example "1 Sep 2026, 09:00". */
export function formatUploadDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/** One line for a bucket: its name, file count and total size. */
export function bucketLabel(bucket: GridFsBucket): string {
  const files = bucket.fileCount === 1 ? '1 file' : `${bucket.fileCount} files`;
  return `${bucket.name} · ${files} · ${formatBytes(bucket.totalBytes)}`;
}

/** The metadata of a file as the table badge shows it: the number of top-level fields. */
export function metadataFieldCount(file: GridFsFile): number {
  if (file.metadataEjson === undefined) {
    return 0;
  }
  const value: unknown = JSON.parse(file.metadataEjson);
  return typeof value === 'object' && value !== null ? Object.keys(value).length : 0;
}

/** The metadata as indented JSON, for the detail drawer and the editor. */
export function formatMetadata(metadataEjson: string | undefined): string {
  if (metadataEjson === undefined) {
    return '{}';
  }
  return JSON.stringify(JSON.parse(metadataEjson), null, 2);
}

export type MetadataDraft =
  | { readonly ok: true; readonly metadataEjson: string }
  | { readonly ok: false; readonly message: string };

/**
 * Checks the metadata the user typed before it is sent. The text must be one JSON object. An empty
 * text clears the metadata. The backend reads the same text as EJSON.
 */
export function parseMetadataDraft(text: string): MetadataDraft {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: true, metadataEjson: '{}' };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { ok: false, message: 'The metadata is not valid JSON.' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, message: 'The metadata must be one JSON object.' };
  }
  return { ok: true, metadataEjson: JSON.stringify(value) };
}

/** A filename check with the core schema. Returns the message to show, or undefined when valid. */
export function filenameProblem(name: string): string | undefined {
  const result = GridFsFilenameSchema.safeParse(name);
  return result.success ? undefined : (result.error.issues[0]?.message ?? 'Enter a file name');
}

/** Joins a folder from a folder dialog and a filename, using the separator the folder uses. */
export function joinFolderPath(folder: string, name: string): string {
  if (folder.endsWith('/') || folder.endsWith('\\')) {
    return `${folder}${name}`;
  }
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return `${folder}${separator}${name}`;
}

/** Keeps the ids that are selected, in the order of the files. */
export function selectedFiles(
  files: readonly GridFsFile[],
  selected: ReadonlySet<string>,
): GridFsFile[] {
  return files.filter((file) => selected.has(file.idEjson));
}

/** Adds the id when it is not selected, and removes it when it is. */
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

/** The fields of a file a sort can use, as the list control names them. */
export const SORT_OPTIONS = [
  { value: 'uploadDate', label: 'Upload date' },
  { value: 'filename', label: 'Name' },
  { value: 'length', label: 'Size' },
] as const;

export type SortValue = (typeof SORT_OPTIONS)[number]['value'];

/** The row limits the list offers. The adapter caps a list at 5000 files. */
export const LIMIT_OPTIONS = [50, 200, 1000] as const;
