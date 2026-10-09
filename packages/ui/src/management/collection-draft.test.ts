import { describe, expect, it } from 'vitest';
import {
  buildCollectionRequest,
  EMPTY_COLLECTION_DRAFT,
  type CollectionDraft,
} from './collection-draft';

function draftWith(patch: Partial<CollectionDraft>): CollectionDraft {
  return { ...EMPTY_COLLECTION_DRAFT, ...patch };
}

describe('buildCollectionRequest', () => {
  it('builds a plain collection with the default level and action', () => {
    expect(buildCollectionRequest(draftWith({ name: ' orders ' }))).toEqual({
      ok: true,
      value: { name: 'orders', validationLevel: 'strict', validationAction: 'error' },
    });
  });

  it('refuses a name the server would refuse, with the rule that failed', () => {
    expect(buildCollectionRequest(draftWith({ name: 'system.users' }))).toEqual({
      ok: false,
      message: 'Collection names may not start with system.',
    });
    expect(buildCollectionRequest(draftWith({ name: '' }))).toEqual({
      ok: false,
      message: 'Enter a collection name',
    });
  });

  it('builds a capped collection with an optional document limit', () => {
    const result = buildCollectionRequest(
      draftWith({
        name: 'events',
        capped: true,
        cappedSizeBytes: '1048576',
        cappedMaxDocuments: '500',
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { capped: { sizeBytes: 1_048_576, maxDocuments: 500 } },
    });
  });

  it('requires a size for a capped collection', () => {
    expect(buildCollectionRequest(draftWith({ name: 'events', capped: true }))).toEqual({
      ok: false,
      message: 'The size of a capped collection is a whole number of bytes',
    });
  });

  it('builds a time series collection with optional fields only when given', () => {
    const result = buildCollectionRequest(
      draftWith({
        name: 'readings',
        timeseries: true,
        timeField: 'ts',
        metaField: '',
        granularity: 'minutes',
        expireAfterSeconds: '86400',
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        timeseries: { timeField: 'ts', granularity: 'minutes', expireAfterSeconds: 86_400 },
      },
    });
    if (result.ok) {
      expect(result.value.timeseries).not.toHaveProperty('metaField');
    }
  });

  it('requires a time field for a time series collection', () => {
    expect(buildCollectionRequest(draftWith({ name: 'readings', timeseries: true }))).toEqual({
      ok: false,
      message: 'A time series collection needs a time field',
    });
  });

  it('refuses a collection that is both capped and timeseries', () => {
    const result = buildCollectionRequest(
      draftWith({
        name: 'x',
        capped: true,
        cappedSizeBytes: '1024',
        timeseries: true,
        timeField: 'ts',
      }),
    );
    expect(result).toEqual({
      ok: false,
      message: 'A collection cannot be both capped and timeseries',
    });
  });

  it('passes the EJSON validator and collation text through after a JSON object check', () => {
    const result = buildCollectionRequest(
      draftWith({
        name: 'orders',
        validatorEjson: '{"status": {"$in": ["paid"]}}',
        collationEjson: '{"locale": "en"}',
        validationLevel: 'moderate',
        validationAction: 'warn',
        clustered: true,
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        name: 'orders',
        validatorEjson: '{"status": {"$in": ["paid"]}}',
        collationEjson: '{"locale": "en"}',
        validationLevel: 'moderate',
        validationAction: 'warn',
        clusteredIndex: true,
      },
    });
  });

  it('names the editor whose text is not a JSON object', () => {
    expect(buildCollectionRequest(draftWith({ name: 'x', validatorEjson: '[]' }))).toEqual({
      ok: false,
      message: 'The validator: The value must be a JSON object',
    });
  });
});
