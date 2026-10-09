import { describe, expect, it } from 'vitest';
import { ShellRequestSchema, ShellResponseSchema } from './protocol';

describe('ShellRequestSchema', () => {
  it('accepts each request kind with its required fields', () => {
    const requests = [
      { id: '1', kind: 'connect', uri: 'mongodb://localhost:27017' },
      { id: '2', kind: 'evaluate', code: '1 + 1', batchSize: 50, timeoutMs: 1000 },
      { id: '3', kind: 'next', batchSize: 25 },
      { id: '4', kind: 'cancel', targetId: '2' },
      { id: '5', kind: 'complete', code: 'db.', position: 3 },
      { id: '6', kind: 'sampleSchema', database: 'shop', collection: 'orders', size: 100 },
      { id: '7', kind: 'disconnect' },
    ];
    for (const request of requests) {
      expect(ShellRequestSchema.safeParse(request).success, request.kind).toBe(true);
    }
  });

  it('accepts a connect request with driver options and a database', () => {
    const result = ShellRequestSchema.safeParse({
      id: '1',
      kind: 'connect',
      uri: 'mongodb+srv://cluster.example.net',
      driverOptions: { appName: 'mongo-gui' },
      database: 'shop',
    });
    expect(result.success).toBe(true);
  });

  it('rejects batch sizes outside 1 to 1000', () => {
    expect(ShellRequestSchema.safeParse({ id: '1', kind: 'next', batchSize: 0 }).success).toBe(
      false,
    );
    expect(ShellRequestSchema.safeParse({ id: '1', kind: 'next', batchSize: 1001 }).success).toBe(
      false,
    );
    expect(ShellRequestSchema.safeParse({ id: '1', kind: 'next', batchSize: 2.5 }).success).toBe(
      false,
    );
    expect(
      ShellRequestSchema.safeParse({ id: '1', kind: 'evaluate', code: '1', batchSize: 1000 })
        .success,
    ).toBe(true);
  });

  it('rejects an empty id and an unknown kind', () => {
    expect(ShellRequestSchema.safeParse({ id: '', kind: 'disconnect' }).success).toBe(false);
    expect(ShellRequestSchema.safeParse({ id: '1', kind: 'drop' }).success).toBe(false);
  });

  it('rejects a connect request whose uri is not a MongoDB URI', () => {
    const result = ShellRequestSchema.safeParse({ id: '1', kind: 'connect', uri: 'http://x' });
    expect(result.success).toBe(false);
  });

  it('rejects a sampleSchema request with a sample size above 1000', () => {
    const result = ShellRequestSchema.safeParse({
      id: '1',
      kind: 'sampleSchema',
      database: 'a',
      collection: 'b',
      size: 5000,
    });
    expect(result.success).toBe(false);
  });
});

describe('ShellResponseSchema', () => {
  it('accepts every response kind', () => {
    const responses = [
      { id: 'process', kind: 'ready' },
      { id: '1', kind: 'connected', serverVersion: '8.0.17', topology: 'standalone' },
      { id: '2', kind: 'print', text: 'hi' },
      {
        id: '2',
        kind: 'result',
        type: 'Cursor',
        printableEjson: '{"documents":[],"cursorHasMore":false}',
        hasMore: false,
        elapsedMs: 4,
      },
      { id: '3', kind: 'completions', items: [{ text: 'db.items.find', kind: 'other' }] },
      {
        id: '4',
        kind: 'schema',
        fields: [{ path: '_id', types: ['ObjectId'], presence: 1 }],
        sampled: 10,
      },
      { id: '5', kind: 'error', error: { code: 'CANCELLED', message: 'Cancelled' } },
      { id: '5', kind: 'done' },
    ];
    for (const response of responses) {
      expect(ShellResponseSchema.safeParse(response).success, response.kind).toBe(true);
    }
  });

  it('rejects an unknown error code or a presence above 1', () => {
    expect(
      ShellResponseSchema.safeParse({
        id: '1',
        kind: 'error',
        error: { code: 'NOPE', message: 'x' },
      }).success,
    ).toBe(false);
    expect(
      ShellResponseSchema.safeParse({
        id: '1',
        kind: 'schema',
        fields: [{ path: 'a', types: ['String'], presence: 1.5 }],
        sampled: 1,
      }).success,
    ).toBe(false);
  });

  it('rejects a completion kind outside the known set', () => {
    const result = ShellResponseSchema.safeParse({
      id: '1',
      kind: 'completions',
      items: [{ text: 'x', kind: 'widget' }],
    });
    expect(result.success).toBe(false);
  });
});
