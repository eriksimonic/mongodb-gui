import type { IndexInfo } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import {
  buildIndexRequest,
  canEditIndex,
  defaultNameFor,
  draftFromIndex,
  EMPTY_INDEX_DRAFT,
  parseWeights,
  previewCommand,
  type IndexDraft,
} from './index-builder';

function draftWith(patch: Partial<IndexDraft>): IndexDraft {
  return { ...EMPTY_INDEX_DRAFT, ...patch };
}

describe('buildIndexRequest', () => {
  it('builds a compound key with the generated name left to the server', () => {
    const result = buildIndexRequest(
      draftWith({
        fields: [
          { field: 'status', order: '1' },
          { field: 'createdAt', order: '-1' },
        ],
      }),
    );
    expect(result).toEqual({ ok: true, keys: { status: 1, createdAt: -1 }, options: {} });
  });

  it('maps the text, hashed, 2dsphere and 2d orders to their key values', () => {
    const result = buildIndexRequest(
      draftWith({
        fields: [
          { field: 'title', order: 'text' },
          { field: 'shard', order: 'hashed' },
          { field: 'location', order: '2dsphere' },
          { field: 'point', order: '2d' },
        ],
      }),
    );
    expect(result).toEqual({
      ok: true,
      keys: { title: 'text', shard: 'hashed', location: '2dsphere', point: '2d' },
      options: {},
    });
  });

  it('sets only the options that are switched on or filled in', () => {
    const result = buildIndexRequest(
      draftWith({
        fields: [{ field: 'email', order: '1' }],
        name: ' email_unique ',
        unique: true,
        sparse: true,
        hidden: true,
        ttlSeconds: '3600',
        partialEjson: '{"active": true}',
        collationEjson: '{"locale": "en", "strength": 2}',
        wildcardEjson: '{"profile": 1}',
      }),
    );
    expect(result).toEqual({
      ok: true,
      keys: { email: 1 },
      options: {
        name: 'email_unique',
        unique: true,
        sparse: true,
        hidden: true,
        expireAfterSeconds: 3600,
        partialFilterExpressionEjson: '{"active": true}',
        collationEjson: '{"locale": "en", "strength": 2}',
        wildcardProjectionEjson: '{"profile": 1}',
      },
    });
  });

  it('keeps unset switches out of the request', () => {
    const result = buildIndexRequest(
      draftWith({ fields: [{ field: 'a', order: '1' }], unique: false }),
    );
    expect(result).toEqual({ ok: true, keys: { a: 1 }, options: {} });
  });

  it('drops blank field rows and reports a key with no field', () => {
    expect(buildIndexRequest(draftWith({ fields: [{ field: '  ', order: '1' }] }))).toEqual({
      ok: false,
      message: 'Add at least one field',
    });
  });

  it('refuses the same field twice', () => {
    const result = buildIndexRequest(
      draftWith({
        fields: [
          { field: 'a', order: '1' },
          { field: 'a', order: '-1' },
        ],
      }),
    );
    expect(result).toEqual({ ok: false, message: 'Each field can appear once in the key' });
  });

  it('refuses a TTL on a compound key, because the server only allows one field', () => {
    const result = buildIndexRequest(
      draftWith({
        fields: [
          { field: 'status', order: '1' },
          { field: 'createdAt', order: '-1' },
        ],
        ttlSeconds: '3600',
      }),
    );
    expect(result).toEqual({ ok: false, message: 'TTL needs a single-field index' });
  });

  it('refuses a TTL that is not a whole number of seconds', () => {
    const result = buildIndexRequest(
      draftWith({ fields: [{ field: 'a', order: '1' }], ttlSeconds: '1.5' }),
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a partial filter that is not a JSON object and names the option', () => {
    const result = buildIndexRequest(
      draftWith({ fields: [{ field: 'a', order: '1' }], partialEjson: '[1, 2]' }),
    );
    expect(result).toEqual({
      ok: false,
      message: 'The partial filter: The value must be a JSON object',
    });
  });

  it('reads text weights and the language only when a text key exists', () => {
    const withText = buildIndexRequest(
      draftWith({
        fields: [{ field: 'title', order: 'text' }],
        weights: 'title: 10\nbody: 2',
        defaultLanguage: 'german',
      }),
    );
    expect(withText).toEqual({
      ok: true,
      keys: { title: 'text' },
      options: { weights: { title: 10, body: 2 }, defaultLanguage: 'german' },
    });

    const withoutText = buildIndexRequest(
      draftWith({
        fields: [{ field: 'a', order: '1' }],
        weights: 'a: 5',
        defaultLanguage: 'german',
      }),
    );
    expect(withoutText).toEqual({ ok: true, keys: { a: 1 }, options: {} });
  });
});

describe('defaultNameFor', () => {
  it('joins field and direction the way the server names an index', () => {
    expect(defaultNameFor({ status: 1, createdAt: -1 })).toBe('status_1_createdAt_-1');
    expect(defaultNameFor({ title: 'text' })).toBe('title_text');
  });
});

describe('parseWeights', () => {
  it('skips blank lines and rejects a line without a number', () => {
    expect(parseWeights('a: 1\n\n b :2.5 ')).toEqual({ a: 1, b: 2.5 });
    expect(parseWeights('a 1')).toBe('Write each weight as "field: number", not "a 1"');
  });
});

describe('previewCommand', () => {
  it('shows the createIndexes command with EJSON options as objects', () => {
    const request = buildIndexRequest(
      draftWith({
        fields: [{ field: 'email', order: '1' }],
        unique: true,
        partialEjson: '{"active": true}',
      }),
    );
    if (!request.ok) {
      throw new Error('expected a valid request');
    }
    expect(previewCommand('customers', request)).toEqual({
      createIndexes: 'customers',
      indexes: [
        {
          key: { email: 1 },
          unique: true,
          partialFilterExpression: { active: true },
        },
      ],
    });
  });
});

describe('draftFromIndex', () => {
  function indexWith(patch: Partial<IndexInfo>): IndexInfo {
    return { name: 'index', key: { a: 1 }, ...patch };
  }

  it('round-trips a compound key with its orders and options', () => {
    const info = indexWith({
      name: 'status_1_createdAt_-1',
      key: { status: 1, createdAt: -1 },
      unique: true,
      sparse: true,
      hidden: true,
      partialFilterExpressionEjson: '{"active":true}',
      collationEjson: '{"locale":"en","strength":2}',
      wildcardProjectionEjson: '{"profile":1}',
    });
    expect(canEditIndex(info)).toBe(true);
    expect(buildIndexRequest(draftFromIndex(info))).toEqual({
      ok: true,
      keys: { status: 1, createdAt: -1 },
      options: {
        name: 'status_1_createdAt_-1',
        unique: true,
        sparse: true,
        hidden: true,
        partialFilterExpressionEjson: '{"active":true}',
        collationEjson: '{"locale":"en","strength":2}',
        wildcardProjectionEjson: '{"profile":1}',
      },
    });
  });

  it('round-trips the expiry of a single-field TTL index', () => {
    const info = indexWith({
      name: 'expiresAt_1',
      key: { expiresAt: 1 },
      expireAfterSeconds: 0,
    });
    expect(buildIndexRequest(draftFromIndex(info))).toEqual({
      ok: true,
      keys: { expiresAt: 1 },
      options: { name: 'expiresAt_1', expireAfterSeconds: 0 },
    });
  });

  it('round-trips hashed, 2dsphere and 2d keys', () => {
    const info = indexWith({
      name: 'mixed',
      key: { shard: 'hashed', location: '2dsphere', point: '2d' },
    });
    expect(buildIndexRequest(draftFromIndex(info))).toEqual({
      ok: true,
      keys: { shard: 'hashed', location: '2dsphere', point: '2d' },
      options: { name: 'mixed' },
    });
  });

  it('rebuilds a text index from its weights, not from the server key entries', () => {
    const info = indexWith({
      name: 'title_text_body_text',
      key: { _fts: 'text', _ftsx: 1 },
      weights: { title: 3, body: 1 },
      defaultLanguage: 'english',
      extraOptionsEjson: '{"textIndexVersion":3}',
    });
    expect(canEditIndex(info)).toBe(true);
    const draft = draftFromIndex(info);
    expect(draft.fields).toEqual([
      { field: 'title', order: 'text' },
      { field: 'body', order: 'text' },
    ]);
    expect(buildIndexRequest(draft)).toEqual({
      ok: true,
      keys: { title: 'text', body: 'text' },
      options: {
        name: 'title_text_body_text',
        weights: { title: 3, body: 1 },
        defaultLanguage: 'english',
        extraOptionsEjson: '{"textIndexVersion":3}',
      },
    });
  });

  it('passes options the dialog has no field for through the request unchanged', () => {
    const info = indexWith({
      name: 'a_1',
      key: { a: 1 },
      extraOptionsEjson: '{"storageEngine":{"wiredTiger":{}}}',
    });
    expect(buildIndexRequest(draftFromIndex(info))).toEqual({
      ok: true,
      keys: { a: 1 },
      options: { name: 'a_1', extraOptionsEjson: '{"storageEngine":{"wiredTiger":{}}}' },
    });
  });

  it('refuses an index whose key the draft cannot hold', () => {
    expect(canEditIndex(indexWith({ key: { loc: 'geoHaystack' } }))).toBe(false);
    expect(canEditIndex(indexWith({ key: { _fts: 'text', _ftsx: 1 } }))).toBe(false);
  });
});
