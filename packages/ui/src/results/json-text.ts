export type JsonMode = 'mongosh' | 'canonical' | 'relaxed';
import { formatMongoshSyntax, formatRelaxedJson } from '@mongo-gui/core';
import type { JsonObject } from './result-model';

export const MODE_LABELS: Readonly<Record<JsonMode, string>> = {
  mongosh: 'mongosh',
  canonical: 'Canonical JSON',
  relaxed: 'Relaxed JSON',
};

const INDENT = 2;

/** The text of the page in one notation. Cursor pages are arrays of documents. */
export function jsonTextFor(
  source: { readonly documents: readonly JsonObject[] } | { readonly printableEjson: string },
  mode: JsonMode,
): string {
  const canonical =
    'documents' in source ? JSON.stringify(source.documents) : source.printableEjson;
  if (mode === 'mongosh') {
    return formatMongoshSyntax(canonical, { indent: INDENT });
  }
  if (mode === 'relaxed') {
    return formatRelaxedJson(canonical);
  }
  return prettyCanonical(canonical);
}

function prettyCanonical(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, INDENT) ?? text;
  } catch {
    return text;
  }
}
