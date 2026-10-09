import { describe, expect, it } from 'vitest';
import { rpcContract } from '../rpc/contract';
import { RpcEventSchema } from '../schemas/events';
import {
  ShellEvaluateInputSchema,
  ShellEvaluationSchema,
  ShellNextInputSchema,
  ShellResultSchema,
  ShellSampleSchemaInputSchema,
} from './rpc-schemas';

const CONNECTION_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const REQUEST_ID = '9b1d4c7a-2e3f-4a6b-8c9d-0e1f2a3b4c5d';

describe('shell evaluate input', () => {
  it('defaults the batch size to 50', () => {
    const parsed = ShellEvaluateInputSchema.parse({
      connectionId: CONNECTION_ID,
      database: 'shop',
      code: 'db.orders.find()',
    });
    expect(parsed.batchSize).toBe(50);
  });

  it('rejects a batch size above 1000 and a batch size below 1', () => {
    const base = { connectionId: CONNECTION_ID, database: 'shop', code: '1' };
    expect(ShellEvaluateInputSchema.safeParse({ ...base, batchSize: 1001 }).success).toBe(false);
    expect(ShellEvaluateInputSchema.safeParse({ ...base, batchSize: 0 }).success).toBe(false);
    expect(ShellEvaluateInputSchema.safeParse({ ...base, batchSize: 1000 }).success).toBe(true);
  });

  it('accepts a caller-chosen request id only when it is a uuid', () => {
    const base = { connectionId: CONNECTION_ID, database: 'shop', code: '1' };
    expect(ShellEvaluateInputSchema.safeParse({ ...base, requestId: REQUEST_ID }).success).toBe(
      true,
    );
    expect(ShellEvaluateInputSchema.safeParse({ ...base, requestId: 'abc' }).success).toBe(false);
  });

  it('rejects a timeout below 100 ms', () => {
    const base = { connectionId: CONNECTION_ID, database: 'shop', code: '1' };
    expect(ShellEvaluateInputSchema.safeParse({ ...base, timeoutMs: 99 }).success).toBe(false);
  });
});

describe('shell next and sampleSchema inputs', () => {
  it('requires a uuid request id for next', () => {
    expect(
      ShellNextInputSchema.safeParse({ connectionId: CONNECTION_ID, requestId: 'x' }).success,
    ).toBe(false);
    expect(
      ShellNextInputSchema.parse({ connectionId: CONNECTION_ID, requestId: REQUEST_ID }).batchSize,
    ).toBe(50);
  });

  it('defaults the sample size to 100', () => {
    const parsed = ShellSampleSchemaInputSchema.parse({
      connectionId: CONNECTION_ID,
      database: 'shop',
      collection: 'orders',
    });
    expect(parsed.size).toBe(100);
  });
});

describe('shell evaluation output', () => {
  it('accepts a cursor result with its cursor request id', () => {
    const value = {
      requestId: REQUEST_ID,
      result: {
        type: 'Cursor',
        printableEjson: '[]',
        hasMore: true,
        cursorRequestId: REQUEST_ID,
      },
      elapsedMs: 4,
    };
    expect(ShellEvaluationSchema.safeParse(value).success).toBe(true);
  });

  it('accepts an error without a result', () => {
    const value = {
      requestId: REQUEST_ID,
      error: { code: 'VALIDATION', message: 'Unexpected token' },
      elapsedMs: 1,
    };
    expect(ShellEvaluationSchema.safeParse(value).success).toBe(true);
  });

  it('rejects a result with an unknown type name', () => {
    const result = { type: 'Mystery', printableEjson: '1', hasMore: false };
    expect(ShellResultSchema.safeParse(result).success).toBe(false);
  });
});

describe('shell contract', () => {
  it('declares every shell call with its schemas', () => {
    expect(Object.keys(rpcContract.shell).sort()).toEqual(
      ['cancel', 'complete', 'evaluate', 'next', 'restart', 'sampleSchema', 'state'].sort(),
    );
  });
});

describe('shell events', () => {
  it('accepts a print event and a state event', () => {
    expect(
      RpcEventSchema.safeParse({
        type: 'shell:print',
        connectionId: CONNECTION_ID,
        requestId: REQUEST_ID,
        text: 'x',
      }).success,
    ).toBe(true);
    expect(
      RpcEventSchema.safeParse({
        type: 'shell:state',
        connectionId: CONNECTION_ID,
        state: 'crashed',
      }).success,
    ).toBe(true);
  });

  it('rejects a state event with a state outside the enum', () => {
    expect(
      RpcEventSchema.safeParse({
        type: 'shell:state',
        connectionId: CONNECTION_ID,
        state: 'exploded',
      }).success,
    ).toBe(false);
  });
});
