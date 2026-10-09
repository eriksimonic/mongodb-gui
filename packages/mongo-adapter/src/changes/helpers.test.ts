import { BSON, Long, ObjectId, Timestamp } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { AppErrorException, ChangeEventSchema, MAX_CHANGE_EVENT_BYTES } from '@mongo-gui/core';
import { parseOperationTime, parsePipeline, parseResumeToken, toChangeEvent } from './helpers';

const DB = 'shop';
const COLL = 'orders';
const ORDER_ID = new ObjectId('64b000000000000000000001');
const CLUSTER_TIME = new Timestamp({ t: 1_700_000_000, i: 4 });
const WALL_TIME = new Date('2026-10-09T08:00:00.000Z');
const TOKEN = { _data: '8265000001000000012B022C0100296E5A10' };
const LSID = { id: { $binary: { base64: 'AAAAAAAAAAAAAAAAAAAAAA==', subType: '04' } } };

function base(operationType: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: TOKEN,
    operationType,
    clusterTime: CLUSTER_TIME,
    wallTime: WALL_TIME,
    ns: { db: DB, coll: COLL },
    ...extra,
  };
}

function parseEjson(text: string | undefined): unknown {
  return text === undefined ? undefined : (JSON.parse(text) as unknown);
}

describe('toChangeEvent', () => {
  it('maps an insert with the full document and the key', () => {
    const raw = base('insert', {
      documentKey: { _id: ORDER_ID },
      fullDocument: { _id: ORDER_ID, status: 'open', total: Long.fromNumber(7) },
    });
    const event = toChangeEvent(raw, 1);

    expect(event.id).toBe('1');
    expect(event.operationType).toBe('insert');
    expect(event.ns).toEqual({ db: DB, coll: COLL });
    expect(event.wallTime).toBe('2026-10-09T08:00:00.000Z');
    expect(parseEjson(event.documentKeyEjson)).toEqual({ _id: { $oid: ORDER_ID.toHexString() } });
    expect(parseEjson(event.fullDocumentEjson)).toEqual({
      _id: { $oid: ORDER_ID.toHexString() },
      status: 'open',
      total: { $numberLong: '7' },
    });
    expect(event.updateDescriptionEjson).toBeUndefined();
    expect(event.truncated).toBeUndefined();
    expect(parseEjson(event.resumeTokenEjson)).toEqual({ _data: TOKEN._data });
    expect(ChangeEventSchema.safeParse(event).success).toBe(true);
  });

  it('maps an update with its update description', () => {
    const raw = base('update', {
      documentKey: { _id: ORDER_ID },
      updateDescription: {
        updatedFields: { status: 'paid' },
        removedFields: ['note'],
        truncatedArrays: [],
      },
    });
    const event = toChangeEvent(raw, 2);

    expect(event.operationType).toBe('update');
    expect(parseEjson(event.updateDescriptionEjson)).toEqual({
      updatedFields: { status: 'paid' },
      removedFields: ['note'],
      truncatedArrays: [],
    });
    expect(event.fullDocumentEjson).toBeUndefined();
  });

  it('maps a replace with the full document', () => {
    const raw = base('replace', {
      documentKey: { _id: ORDER_ID },
      fullDocument: { _id: ORDER_ID, status: 'shipped' },
    });
    const event = toChangeEvent(raw, 3);

    expect(event.operationType).toBe('replace');
    expect(parseEjson(event.fullDocumentEjson)).toEqual({
      _id: { $oid: ORDER_ID.toHexString() },
      status: 'shipped',
    });
  });

  it('maps a delete with the key and the pre-image when it is present', () => {
    const raw = base('delete', {
      documentKey: { _id: ORDER_ID },
      fullDocumentBeforeChange: { _id: ORDER_ID, status: 'open' },
    });
    const event = toChangeEvent(raw, 4);

    expect(event.operationType).toBe('delete');
    expect(event.fullDocumentEjson).toBeUndefined();
    expect(parseEjson(event.fullDocumentBeforeChangeEjson)).toEqual({
      _id: { $oid: ORDER_ID.toHexString() },
      status: 'open',
    });
  });

  it('maps a drop with a collection namespace and no key', () => {
    const event = toChangeEvent(base('drop'), 5);

    expect(event.operationType).toBe('drop');
    expect(event.ns).toEqual({ db: DB, coll: COLL });
    expect(event.documentKeyEjson).toBeUndefined();
  });

  it('maps a rename with the target namespace', () => {
    const raw = base('rename', { to: { db: DB, coll: 'archived' } });
    const event = toChangeEvent(raw, 6);

    expect(event.operationType).toBe('rename');
    expect(event.to).toEqual({ db: DB, coll: 'archived' });
  });

  it('maps a dropDatabase with a namespace that has no collection', () => {
    const event = toChangeEvent(base('dropDatabase', { ns: { db: DB } }), 7);

    expect(event.operationType).toBe('dropDatabase');
    expect(event.ns).toEqual({ db: DB });
  });

  it('maps an invalidate with no namespace', () => {
    const raw = { _id: TOKEN, operationType: 'invalidate', clusterTime: CLUSTER_TIME };
    const event = toChangeEvent(raw, 8);

    expect(event.operationType).toBe('invalidate');
    expect(event.ns).toBeUndefined();
    expect(event.clusterTimeEjson).toBeDefined();
  });

  it('maps the 6.0 expanded events, keeping their description in the raw document', () => {
    const cases = [
      { operationType: 'createIndexes', operationDescription: { indexes: [{ name: 'status_1' }] } },
      { operationType: 'modify', operationDescription: { collMod: COLL } },
      {
        operationType: 'shardCollection',
        operationDescription: { shardKey: { status: 1 } },
      },
    ];
    cases.forEach((extra, index) => {
      const event = toChangeEvent(base(extra.operationType, extra), 9 + index);

      expect(event.operationType).toBe(extra.operationType);
      expect(event.ns).toEqual({ db: DB, coll: COLL });
      expect(JSON.parse(event.rawEjson)).toMatchObject({
        operationType: extra.operationType,
        operationDescription: JSON.parse(
          BSON.EJSON.stringify(extra.operationDescription, { relaxed: false }),
        ) as unknown,
      });
    });
  });

  it('carries the transaction fields when the event belongs to a transaction', () => {
    const event = toChangeEvent(base('insert', { txnNumber: 3, lsid: LSID }), 10);

    expect(event.txnNumber).toBe(3);
    expect(parseEjson(event.lsidEjson)).toEqual(LSID);
  });

  it('records the BSON size and the canonical raw form', () => {
    const raw = base('insert', { documentKey: { _id: ORDER_ID } });
    const event = toChangeEvent(raw, 11);

    expect(event.sizeBytes).toBeGreaterThan(0);
    expect(JSON.parse(event.rawEjson)).toMatchObject({
      operationType: 'insert',
      documentKey: { _id: { $oid: ORDER_ID.toHexString() } },
    });
  });

  it('keeps only the key fields of an event over the size limit and flags it', () => {
    const big = 'x'.repeat(MAX_CHANGE_EVENT_BYTES + 1024);
    const raw = base('insert', {
      documentKey: { _id: ORDER_ID },
      fullDocument: { _id: ORDER_ID, payload: big },
    });
    const event = toChangeEvent(raw, 12);

    expect(event.truncated).toBe(true);
    expect(event.sizeBytes).toBeGreaterThan(MAX_CHANGE_EVENT_BYTES);
    expect(event.fullDocumentEjson).toBeUndefined();
    expect(event.clusterTimeEjson).toBeUndefined();
    expect(event.rawEjson.length).toBeLessThan(1024);
    expect(JSON.parse(event.rawEjson)).toEqual({
      _id: TOKEN,
      operationType: 'insert',
      ns: { db: DB, coll: COLL },
      documentKey: { _id: { $oid: ORDER_ID.toHexString() } },
    });
    expect(ChangeEventSchema.safeParse(event).success).toBe(true);
  });

  it('maps a value that is not a document to an unknown event with an empty token', () => {
    const event = toChangeEvent('not a change', 13);

    expect(event.operationType).toBe('unknown');
    expect(event.resumeTokenEjson).toBe('null');
    expect(ChangeEventSchema.safeParse(event).success).toBe(true);
  });
});

describe('parsePipeline', () => {
  it('parses an array of stages', () => {
    const stages = parsePipeline('[{"$match":{"operationType":"insert"}}]');

    expect(stages).toEqual([{ $match: { operationType: 'insert' } }]);
  });

  it('accepts an empty array', () => {
    expect(parsePipeline('[]')).toEqual([]);
  });

  it('requires an array', () => {
    expect(() => parsePipeline('{"$match":{}}')).toThrow(AppErrorException);
    expect(() => parsePipeline('{"$match":{}}')).toThrow(/must be an array/);
  });

  it('requires every stage to be an object', () => {
    expect(() => parsePipeline('[{"$match":{}}, 5]')).toThrow(/must be an object/);
    expect(() => parsePipeline('[[{"$match":{}}]]')).toThrow(/must be an object/);
  });

  it('refuses $out and $merge stages', () => {
    expect(() => parsePipeline('[{"$out":"copy"}]')).toThrow(/\$out is not allowed/);
    expect(() => parsePipeline('[{"$merge":{"into":"copy"}}]')).toThrow(/\$merge is not allowed/);
  });

  it('reports text that is not extended JSON as a validation error', () => {
    try {
      parsePipeline('[{"$match":');
      expect.unreachable('parsing should fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AppErrorException);
      expect((error as AppErrorException).error.code).toBe('VALIDATION');
    }
  });
});

describe('parseResumeToken and parseOperationTime', () => {
  it('parses a resume token document', () => {
    expect(parseResumeToken(JSON.stringify(TOKEN))).toEqual(TOKEN);
  });

  it('refuses a resume token that is not a document', () => {
    expect(() => parseResumeToken('"8265"')).toThrow(/must be a document/);
  });

  it('parses an operation time into a timestamp', () => {
    const parsed = parseOperationTime('{"$timestamp":{"t":1700000000,"i":4}}');

    expect(parsed).toBeInstanceOf(Timestamp);
    expect(parsed.getHighBits()).toBe(1_700_000_000);
    expect(parsed.getLowBits()).toBe(4);
  });

  it('refuses an operation time that is not a timestamp', () => {
    expect(() => parseOperationTime('{"t":1}')).toThrow(/BSON timestamp/);
  });
});
