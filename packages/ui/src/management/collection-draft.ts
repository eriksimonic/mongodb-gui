import type { CreateCollectionInput, ValidationLevel, ValidationAction } from '@mongo-gui/core';
import { collectionNameError, parseJsonObject } from './input-rules';

export type Granularity = 'seconds' | 'minutes' | 'hours';

/** The create collection form. Numeric fields stay as typed until the builder reads them. */
export interface CollectionDraft {
  readonly name: string;
  readonly capped: boolean;
  readonly cappedSizeBytes: string;
  readonly cappedMaxDocuments: string;
  readonly timeseries: boolean;
  readonly timeField: string;
  readonly metaField: string;
  readonly granularity: Granularity | '';
  readonly expireAfterSeconds: string;
  readonly clustered: boolean;
  readonly collationEjson: string;
  readonly validatorEjson: string;
  readonly validationLevel: ValidationLevel;
  readonly validationAction: ValidationAction;
}

export const EMPTY_COLLECTION_DRAFT: CollectionDraft = {
  name: '',
  capped: false,
  cappedSizeBytes: '',
  cappedMaxDocuments: '',
  timeseries: false,
  timeField: '',
  metaField: '',
  granularity: '',
  expireAfterSeconds: '',
  clustered: false,
  collationEjson: '',
  validatorEjson: '',
  validationLevel: 'strict',
  validationAction: 'error',
};

export type CollectionOptions = Omit<CreateCollectionInput, 'database'>;

export type CollectionRequest =
  | { readonly ok: true; readonly value: CollectionOptions }
  | { readonly ok: false; readonly message: string };

/** A whole number of at least one, or undefined when the text is not one. */
function positiveInteger(text: string): number | undefined {
  const value = Number(text.trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function optionalPositive(text: string, label: string): { value?: number; error?: string } {
  const trimmed = text.trim();
  if (trimmed === '') {
    return {};
  }
  const value = positiveInteger(trimmed);
  return value === undefined ? { error: `${label} must be a whole number above zero` } : { value };
}

/** Turns the form into the create collection options. The first problem found is returned. */
export function buildCollectionRequest(draft: CollectionDraft): CollectionRequest {
  const nameProblem = collectionNameError(draft.name.trim());
  if (nameProblem !== undefined) {
    return { ok: false, message: nameProblem };
  }
  if (draft.capped && draft.timeseries) {
    return { ok: false, message: 'A collection cannot be both capped and timeseries' };
  }
  const value: CollectionOptions = {
    name: draft.name.trim(),
    validationLevel: draft.validationLevel,
    validationAction: draft.validationAction,
  };

  if (draft.capped) {
    const size = positiveInteger(draft.cappedSizeBytes);
    if (size === undefined) {
      return { ok: false, message: 'The size of a capped collection is a whole number of bytes' };
    }
    const max = optionalPositive(draft.cappedMaxDocuments, 'The maximum document count');
    if (max.error !== undefined) {
      return { ok: false, message: max.error };
    }
    value.capped = {
      sizeBytes: size,
      ...(max.value === undefined ? {} : { maxDocuments: max.value }),
    };
  }

  if (draft.timeseries) {
    const timeField = draft.timeField.trim();
    if (timeField === '') {
      return { ok: false, message: 'A time series collection needs a time field' };
    }
    const expiry = optionalPositive(draft.expireAfterSeconds, 'The expiry');
    if (expiry.error !== undefined) {
      return { ok: false, message: expiry.error };
    }
    const metaField = draft.metaField.trim();
    value.timeseries = {
      timeField,
      ...(metaField === '' ? {} : { metaField }),
      ...(draft.granularity === '' ? {} : { granularity: draft.granularity }),
      ...(expiry.value === undefined ? {} : { expireAfterSeconds: expiry.value }),
    };
  }

  if (draft.clustered) {
    value.clusteredIndex = true;
  }

  const collation = draft.collationEjson.trim();
  if (collation !== '') {
    const parsed = parseJsonObject(collation);
    if (!parsed.ok) {
      return { ok: false, message: `The collation: ${parsed.message}` };
    }
    value.collationEjson = collation;
  }

  const validator = draft.validatorEjson.trim();
  if (validator !== '') {
    const parsed = parseJsonObject(validator);
    if (!parsed.ok) {
      return { ok: false, message: `The validator: ${parsed.message}` };
    }
    value.validatorEjson = validator;
  }

  return { ok: true, value };
}
