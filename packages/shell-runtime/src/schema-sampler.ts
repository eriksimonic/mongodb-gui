import { EJSON } from 'bson';
import { summarizeCanonicalSample, type SchemaSummary } from '@mongo-gui/core';

export type { SchemaSummary };

/**
 * Reports the fields of the sampled documents. The driver returns BSON values, so each document is
 * first written as canonical EJSON, and the walk in core reads that form. Keeping BSON wrappers
 * (Int32, Long, Double) in the sample lets the walk name their types.
 */
export function summarizeDocuments(documents: readonly unknown[]): SchemaSummary {
  return summarizeCanonicalSample(documents.map(toCanonicalDocument));
}

function toCanonicalDocument(document: unknown): unknown {
  if (!isPlainObject(document)) {
    return undefined;
  }
  return EJSON.serialize(document, { relaxed: false });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
