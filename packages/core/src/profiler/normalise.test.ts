import { describe, expect, it } from 'vitest';
import { toProfileEntry } from './normalise';
import { ProfileEntrySchema } from './types';

// Hand-written system.profile documents. The shapes follow the server output for each major
// version: 4.4 reports find as op "query" with a command, legacy writes carry the filter in
// "query" and the update document in "updateobj", 6.0 and later report reads as op "command",
// and 8.0 adds queryHash and planCacheKey to every read.
const SHAPE_4_4_FIND = {
  op: 'query',
  ns: 'shop.orders',
  command: { find: 'orders', filter: { status: 'paid' }, limit: 50, $db: 'shop' },
  keysExamined: 0,
  docsExamined: 50,
  hasSortStage: false,
  usedDisk: false,
  cursorExhausted: true,
  nreturned: 25,
  queryHash: 'A1B2C3D4',
  planCacheKey: '5F6E7D8C',
  planSummary: 'COLLSCAN',
  client: '127.0.0.1',
  appName: 'mongosh',
  user: 'root@admin',
  responseLength: 1234,
  protocol: 'op_msg',
  millis: 5,
  ts: new Date('2026-10-05T08:15:00.000Z'),
  opid: 1001,
};

const SHAPE_4_4_LEGACY_UPDATE = {
  op: 'update',
  ns: 'shop.orders',
  query: { orderNumber: 3 },
  updateobj: { $set: { touched: true } },
  keysExamined: 0,
  docsExamined: 50,
  nMatched: 1,
  nModified: 1,
  planSummary: 'COLLSCAN',
  millis: 2,
  ts: new Date('2026-10-05T08:15:01.000Z'),
  opid: 1002,
};

const SHAPE_6_0_AGGREGATE = {
  op: 'command',
  ns: 'shop.orders',
  command: {
    aggregate: 'orders',
    pipeline: [{ $match: { status: 'paid' } }, { $count: 'n' }],
    cursor: {},
    $db: 'shop',
  },
  keysExamined: 0,
  docsExamined: 50,
  cursorExhausted: true,
  nreturned: 1,
  planSummary: 'COLLSCAN',
  millis: 7,
  ts: new Date('2026-10-05T08:15:02.000Z'),
  opid: 2001,
};

const SHAPE_6_0_UPDATE = {
  op: 'update',
  ns: 'shop.orders',
  command: {
    q: { orderNumber: 4 },
    u: { $set: { touched: true } },
    multi: false,
    upsert: false,
  },
  keysExamined: 1,
  docsExamined: 1,
  nMatched: 1,
  nModified: 1,
  planSummary: 'IXSCAN { orderNumber: 1 }',
  millis: 1,
  ts: new Date('2026-10-05T08:15:03.000Z'),
  opid: 2002,
};

const SHAPE_6_0_GETMORE = {
  op: 'getmore',
  ns: 'shop.orders',
  command: { getMore: 123456789, collection: 'orders', $db: 'shop' },
  originatingCommand: { find: 'orders', filter: {} },
  nreturned: 10,
  millis: 0,
  ts: new Date('2026-10-05T08:15:04.000Z'),
  opid: 2003,
};

const SHAPE_6_0_REMOVE = {
  op: 'remove',
  ns: 'shop.orders',
  command: { q: { orderNumber: 99 }, limit: 1 },
  ndeleted: 1,
  millis: 1,
  ts: new Date('2026-10-05T08:15:05.000Z'),
  opid: 2004,
};

const SHAPE_6_0_COUNT = {
  op: 'command',
  ns: 'shop.orders',
  command: { count: 'orders', query: { status: 'open' }, $db: 'shop' },
  planSummary: 'COLLSCAN',
  millis: 3,
  ts: new Date('2026-10-05T08:15:06.000Z'),
  opid: 2005,
};

const SHAPE_8_0_FIND = {
  op: 'command',
  ns: 'shop.orders',
  command: { find: 'orders', filter: { status: 'paid' }, $db: 'shop' },
  keysExamined: 50,
  docsExamined: 50,
  hasSortStage: true,
  usedDisk: false,
  nreturned: 25,
  queryHash: 'B2C3D4E5',
  planCacheKey: '6A7B8C9D',
  planSummary: 'IXSCAN { status: 1, createdAt: -1 }',
  millis: 4,
  ts: new Date('2026-10-05T08:15:07.000Z'),
  opid: 3001,
  appName: 'mongo-gui',
  client: '10.0.0.5:51234',
};

describe('toProfileEntry with 4.4 documents', () => {
  it('maps a find reported as op query with its command and plan fields', () => {
    const entry = toProfileEntry(SHAPE_4_4_FIND);
    expect(entry).toMatchObject({
      op: 'query',
      ns: 'shop.orders',
      millis: 5,
      ts: '2026-10-05T08:15:00.000Z',
      keysExamined: 0,
      docsExamined: 50,
      nreturned: 25,
      queryHash: 'A1B2C3D4',
      planCacheKey: '5F6E7D8C',
      planSummary: 'COLLSCAN',
      client: '127.0.0.1',
      appName: 'mongosh',
      user: 'root@admin',
      responseLength: 1234,
      hasSortStage: false,
      usedDisk: false,
    });
    expect(entry.command).toEqual(SHAPE_4_4_FIND.command);
    expect(entry.raw).toBe(SHAPE_4_4_FIND);
  });

  it('maps a legacy update, keeping the filter and update document as the command', () => {
    const entry = toProfileEntry(SHAPE_4_4_LEGACY_UPDATE);
    expect(entry.op).toBe('update');
    expect(entry.nMatched).toBe(1);
    expect(entry.nModified).toBe(1);
    expect(entry.command).toEqual({
      query: { orderNumber: 3 },
      updateobj: { $set: { touched: true } },
    });
  });
});

describe('toProfileEntry with 6.0 documents', () => {
  it('maps an aggregate reported as op command to query', () => {
    const entry = toProfileEntry(SHAPE_6_0_AGGREGATE);
    expect(entry.op).toBe('query');
    expect(entry.planSummary).toBe('COLLSCAN');
    expect(entry.nreturned).toBe(1);
  });

  it('maps an update with nMatched and nModified', () => {
    const entry = toProfileEntry(SHAPE_6_0_UPDATE);
    expect(entry).toMatchObject({ op: 'update', nMatched: 1, nModified: 1, keysExamined: 1 });
  });

  it('maps getmore by its command name', () => {
    expect(toProfileEntry(SHAPE_6_0_GETMORE).op).toBe('getmore');
  });

  it('maps a delete reported as op remove', () => {
    expect(toProfileEntry(SHAPE_6_0_REMOVE).op).toBe('remove');
  });

  it('keeps count as op command', () => {
    expect(toProfileEntry(SHAPE_6_0_COUNT).op).toBe('command');
  });
});

describe('toProfileEntry with 8.0 documents', () => {
  it('maps a find reported as op command to query and keeps the query hashes', () => {
    const entry = toProfileEntry(SHAPE_8_0_FIND);
    expect(entry).toMatchObject({
      op: 'query',
      queryHash: 'B2C3D4E5',
      planCacheKey: '6A7B8C9D',
      hasSortStage: true,
      appName: 'mongo-gui',
    });
  });
});

describe('toProfileEntry with insert and unknown shapes', () => {
  it('maps a plain insert', () => {
    const entry = toProfileEntry({
      op: 'insert',
      ns: 'shop.orders',
      ninserted: 1,
      millis: 0,
      ts: new Date('2026-10-05T08:16:00.000Z'),
      opid: 4001,
    });
    expect(entry.op).toBe('insert');
  });

  it('maps an unknown op to other and keeps the raw document', () => {
    const raw = {
      op: 'flushRouterConfig',
      ns: 'admin.$cmd',
      millis: 9,
      ts: '2026-10-05T08:16:01Z',
    };
    const entry = toProfileEntry(raw);
    expect(entry.op).toBe('other');
    expect(entry.raw).toBe(raw);
    expect(entry.millis).toBe(9);
  });

  it.each([null, undefined, 'not a document', 42, [1, 2, 3]])(
    'never throws for %j and returns an other entry',
    (value) => {
      const entry = toProfileEntry(value);
      expect(entry.op).toBe('other');
      expect(entry.raw).toBe(value);
      expect(ProfileEntrySchema.safeParse(entry).success).toBe(true);
    },
  );

  it('tolerates a document with only an op', () => {
    const entry = toProfileEntry({ op: 'query' });
    expect(entry).toMatchObject({ op: 'query', ns: '', millis: 0, ts: '1970-01-01T00:00:00.000Z' });
    expect(ProfileEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('ignores fields of the wrong type', () => {
    const entry = toProfileEntry({
      op: 'query',
      ns: 42,
      millis: 'slow',
      nreturned: Number.NaN,
      planSummary: ['COLLSCAN'],
      ts: 'not a date',
    });
    expect(entry).toMatchObject({ ns: '', millis: 0, ts: '1970-01-01T00:00:00.000Z' });
    expect(entry.nreturned).toBeUndefined();
    expect(entry.planSummary).toBeUndefined();
  });

  it('accepts a timestamp given as an ISO string', () => {
    expect(toProfileEntry({ op: 'query', ts: '2026-10-05T08:15:00Z' }).ts).toBe(
      '2026-10-05T08:15:00.000Z',
    );
  });

  it('accepts a bigint millis value', () => {
    expect(toProfileEntry({ op: 'query', millis: BigInt(12) }).millis).toBe(12);
  });
});

describe('toProfileEntry errCode', () => {
  it('maps the server error code', () => {
    const entry = toProfileEntry({ op: 'query', ns: 'shop.orders', errCode: 2, errMsg: 'bad' });
    expect(entry).toMatchObject({ errCode: 2, errMsg: 'bad' });
  });
});

describe('toProfileEntry id', () => {
  it('hashes a bigint field instead of dropping it', () => {
    const ts = '2026-10-05T08:15:00.000Z';
    const first = toProfileEntry({ op: 'query', ts, big: BigInt(1) });
    const second = toProfileEntry({ op: 'query', ts, big: BigInt(2) });
    expect(first.id).toMatch(/^[0-9a-f]{16}$/);
    expect(first.id).not.toBe(second.id);
  });

  it('is 16 hex characters and the same for the same document', () => {
    const first = toProfileEntry(SHAPE_4_4_FIND);
    const second = toProfileEntry({ ...SHAPE_4_4_FIND });
    expect(first.id).toMatch(/^[0-9a-f]{16}$/);
    expect(second.id).toBe(first.id);
  });

  it('differs when the opid differs', () => {
    const other = toProfileEntry({ ...SHAPE_4_4_FIND, opid: 1999 });
    expect(other.id).not.toBe(toProfileEntry(SHAPE_4_4_FIND).id);
  });

  it('uses _id when no opid is present', () => {
    const withId = toProfileEntry({ op: 'query', ts: SHAPE_4_4_FIND.ts, _id: 'abc' });
    const otherId = toProfileEntry({ op: 'query', ts: SHAPE_4_4_FIND.ts, _id: 'abd' });
    expect(withId.id).not.toBe(otherId.id);
  });

  it('hashes the command when neither opid nor _id is present', () => {
    const base = { op: 'query', ns: 'shop.orders', ts: SHAPE_4_4_FIND.ts, millis: 5 };
    const first = toProfileEntry({ ...base, command: { find: 'orders', filter: { a: 1 } } });
    const second = toProfileEntry({ ...base, command: { find: 'orders', filter: { a: 2 } } });
    expect(first.id).not.toBe(second.id);
  });

  it('is accepted by the entry schema for every fixture', () => {
    const fixtures = [
      SHAPE_4_4_FIND,
      SHAPE_4_4_LEGACY_UPDATE,
      SHAPE_6_0_AGGREGATE,
      SHAPE_6_0_UPDATE,
      SHAPE_6_0_GETMORE,
      SHAPE_6_0_REMOVE,
      SHAPE_6_0_COUNT,
      SHAPE_8_0_FIND,
    ];
    for (const fixture of fixtures) {
      expect(ProfileEntrySchema.safeParse(toProfileEntry(fixture)).success).toBe(true);
    }
  });
});
