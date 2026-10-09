import { describe, expect, it } from 'vitest';
import type { Document, MongoClient } from 'mongodb';
import {
  explainableCommand,
  parseCommandEjson,
  runExplainCommand,
  wrapWriteCommand,
} from './run-explain';

describe('parseCommandEjson', () => {
  it('parses canonical EJSON into an object with BSON values', () => {
    const parsed = parseCommandEjson(
      '{"find":"orders","filter":{"_id":{"$oid":"64b7f0c2a1b2c3d4e5f60718"}}}',
    );
    expect(parsed).toBeDefined();
    expect(parsed?.['find']).toBe('orders');
    expect(parsed?.['filter']).toBeDefined();
  });

  it('parses relaxed EJSON too', () => {
    expect(parseCommandEjson('{"find":"orders","limit":5}')?.['limit']).toBe(5);
  });

  it('returns undefined for text that is not JSON', () => {
    expect(parseCommandEjson('{find: orders')).toBeUndefined();
  });

  it('returns undefined for a JSON array or a scalar', () => {
    expect(parseCommandEjson('[1, 2]')).toBeUndefined();
    expect(parseCommandEjson('"find"')).toBeUndefined();
    expect(parseCommandEjson('null')).toBeUndefined();
  });
});

describe('explainableCommand', () => {
  it('drops the $-prefixed fields and the session fields', () => {
    const command: Document = {
      find: 'orders',
      filter: { status: 'paid' },
      $db: 'shop',
      $clusterTime: { clusterTime: 1 },
      lsid: { id: 'session' },
      txnNumber: 4,
      autocommit: false,
      startTransaction: true,
    };
    expect(explainableCommand(command)).toEqual({ find: 'orders', filter: { status: 'paid' } });
  });

  it('refuses a getMore command', () => {
    expect(explainableCommand({ getMore: 1, collection: 'orders' })).toBeUndefined();
  });

  it('refuses a command that is already an explain', () => {
    expect(explainableCommand({ explain: { find: 'orders' } })).toBeUndefined();
  });

  it('refuses an empty command', () => {
    expect(explainableCommand({})).toBeUndefined();
  });

  it('keeps the fields that a command needs', () => {
    expect(explainableCommand({ count: 'orders', query: { status: 'paid' } })).toEqual({
      count: 'orders',
      query: { status: 'paid' },
    });
  });
});

describe('wrapWriteCommand', () => {
  it('puts a profiled update statement in an update command', () => {
    const statement: Document = { q: { status: 'paid' }, u: { $set: { x: 1 } }, multi: true };
    expect(wrapWriteCommand(statement, 'update', 'orders')).toEqual({
      update: 'orders',
      updates: [statement],
    });
  });

  it('puts a profiled remove statement in a delete command with its limit', () => {
    expect(wrapWriteCommand({ q: { status: 'cancelled' }, limit: 0 }, 'remove', 'orders')).toEqual({
      delete: 'orders',
      deletes: [{ q: { status: 'cancelled' }, limit: 0 }],
    });
  });

  it('defaults a remove statement to an empty filter and no limit', () => {
    expect(wrapWriteCommand({}, 'remove', 'orders')).toEqual({
      delete: 'orders',
      deletes: [{ q: {}, limit: 0 }],
    });
  });

  it('wrapped commands pass through explainableCommand', () => {
    const wrapped = wrapWriteCommand({ q: {}, u: { $set: { x: 1 } } }, 'update', 'orders');
    expect(explainableCommand(wrapped)).toEqual(wrapped);
  });
});

function fakeClient(reply: unknown, calls: unknown[][]): MongoClient {
  const database = {
    command: (...args: unknown[]): Promise<unknown> => {
      calls.push(args);
      return Promise.resolve(reply);
    },
  };
  return { db: () => database } as unknown as MongoClient;
}

describe('runExplainCommand', () => {
  it('runs the explain command with the verbosity and returns the plan as plain JSON', async () => {
    const calls: unknown[][] = [];
    const client = fakeClient({ ok: 1, queryPlanner: { winningPlan: {} } }, calls);
    const result = await runExplainCommand(client, {
      database: 'shop',
      command: { find: 'orders', filter: { status: 'paid' }, $db: 'shop' },
      verbosity: 'queryPlanner',
    });
    expect(calls).toHaveLength(1);
    const [command] = calls[0] ?? [];
    expect(command).toEqual({
      explain: { find: 'orders', filter: { status: 'paid' } },
      verbosity: 'queryPlanner',
    });
    expect(result?.raw).toMatchObject({ queryPlanner: { winningPlan: {} } });
    expect(result?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('returns undefined and runs nothing for a getMore', async () => {
    const calls: unknown[][] = [];
    const result = await runExplainCommand(fakeClient({}, calls), {
      database: 'shop',
      command: { getMore: 7, collection: 'orders' },
      verbosity: 'executionStats',
    });
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
