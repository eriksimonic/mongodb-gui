import { describe, expect, it } from 'vitest';
import type { RpcEvent } from '@mongo-gui/core';
import { createMockUiApi } from './mock-rpc-client';
import { localConnectionId } from './mock-fixtures';

const DATABASE = 'shop';
const COLLECTION = 'orders';

function connectedApi() {
  const api = createMockUiApi({ preset: 'unlocked' });
  const events: RpcEvent[] = [];
  api.onEvent((event) => events.push(event));
  return { api, events };
}

function batchOf(printable: string): { cursorHasMore: boolean; documents: unknown[] } {
  return JSON.parse(printable) as { cursorHasMore: boolean; documents: unknown[] };
}

describe('mock shell', () => {
  it('refuses evaluate for a connection that is not open', async () => {
    const { api } = connectedApi();
    await expect(
      api.rpc.shell.evaluate({ connectionId: localConnectionId, database: DATABASE, code: '1' }),
    ).rejects.toMatchObject({ error: { code: 'NOT_CONNECTED' } });
  });

  it('pages find results with batchSize and hasMore, then next continues', async () => {
    const { api } = connectedApi();
    await api.rpc.connections.connect({ id: localConnectionId });
    const first = await api.rpc.shell.evaluate({
      connectionId: localConnectionId,
      database: DATABASE,
      code: `db.${COLLECTION}.find({})`,
      batchSize: 25,
    });
    expect(first.result?.type).toBe('Cursor');
    expect(batchOf(first.result?.printableEjson ?? '').documents).toHaveLength(25);
    expect(first.result?.hasMore).toBe(true);
    expect(first.result?.cursorRequestId).toBe(first.requestId);

    const second = await api.rpc.shell.next({
      connectionId: localConnectionId,
      requestId: first.requestId,
      batchSize: 25,
    });
    expect(batchOf(second.result?.printableEjson ?? '').documents).toHaveLength(25);
    expect(second.result?.hasMore).toBe(true);
  });

  it('honours a limit on the find', async () => {
    const { api } = connectedApi();
    await api.rpc.connections.connect({ id: localConnectionId });
    const outcome = await api.rpc.shell.evaluate({
      connectionId: localConnectionId,
      database: DATABASE,
      code: `db.${COLLECTION}.find({}).limit(5)`,
      batchSize: 50,
    });
    expect(batchOf(outcome.result?.printableEjson ?? '').documents).toHaveLength(5);
    expect(outcome.result?.hasMore).toBe(false);
  });

  it('answers countDocuments with the fixture count', async () => {
    const { api } = connectedApi();
    await api.rpc.connections.connect({ id: localConnectionId });
    const outcome = await api.rpc.shell.evaluate({
      connectionId: localConnectionId,
      database: DATABASE,
      code: `db.${COLLECTION}.countDocuments({})`,
      batchSize: 50,
    });
    expect(outcome.result).toEqual({
      type: 'number',
      printableEjson: '{"$numberInt":"240"}',
      hasMore: false,
    });
  });

  it('emits print lines as shell:print events', async () => {
    const { api, events } = connectedApi();
    await api.rpc.connections.connect({ id: localConnectionId });
    const outcome = await api.rpc.shell.evaluate({
      connectionId: localConnectionId,
      database: DATABASE,
      code: "print('x')",
      batchSize: 50,
    });
    expect(outcome.result?.type).toBe('undefined');
    expect(events).toContainEqual({
      type: 'shell:print',
      connectionId: localConnectionId,
      requestId: outcome.requestId,
      text: 'x',
    });
  });

  it('reports unbalanced parentheses as a VALIDATION error in the evaluation', async () => {
    const { api } = connectedApi();
    await api.rpc.connections.connect({ id: localConnectionId });
    const outcome = await api.rpc.shell.evaluate({
      connectionId: localConnectionId,
      database: DATABASE,
      code: `db.${COLLECTION}.find(`,
      batchSize: 50,
    });
    expect(outcome.error?.code).toBe('VALIDATION');
  });

  it('cancels a running sleep', async () => {
    const { api } = connectedApi();
    await api.rpc.connections.connect({ id: localConnectionId });
    const requestId = '4c1f2a3b-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    const running = api.rpc.shell.evaluate({
      connectionId: localConnectionId,
      requestId,
      database: DATABASE,
      code: 'sleep(10000)',
      batchSize: 50,
    });
    await api.rpc.shell.cancel({ connectionId: localConnectionId, requestId });
    const outcome = await running;
    expect(outcome.error?.code).toBe('CANCELLED');
  });

  it('answers getName and echoes other code as a string', async () => {
    const { api } = connectedApi();
    await api.rpc.connections.connect({ id: localConnectionId });
    const name = await api.rpc.shell.evaluate({
      connectionId: localConnectionId,
      database: DATABASE,
      code: 'db.getName()',
      batchSize: 50,
    });
    expect(name.result).toEqual({ type: 'string', printableEjson: '"shop"', hasMore: false });
    const echo = await api.rpc.shell.evaluate({
      connectionId: localConnectionId,
      database: DATABASE,
      code: '1 + 1',
      batchSize: 50,
    });
    expect(echo.result).toEqual({ type: 'string', printableEjson: '"1 + 1"', hasMore: false });
  });

  it('completes collection methods after a collection and collection names after db', async () => {
    const { api } = connectedApi();
    await api.rpc.connections.connect({ id: localConnectionId });
    const member = await api.rpc.shell.complete({
      connectionId: localConnectionId,
      database: DATABASE,
      code: 'db.orders.',
      position: 10,
    });
    expect(member.items.map((item) => item.text)).toEqual([
      'find',
      'findOne',
      'aggregate',
      'countDocuments',
    ]);
    const root = await api.rpc.shell.complete({
      connectionId: localConnectionId,
      database: DATABASE,
      code: 'db.',
      position: 3,
    });
    expect(root.items).toContainEqual({ text: 'orders', kind: 'collection' });
  });

  it('samples a schema from the fixture documents', async () => {
    const { api } = connectedApi();
    await api.rpc.connections.connect({ id: localConnectionId });
    const schema = await api.rpc.shell.sampleSchema({
      connectionId: localConnectionId,
      database: DATABASE,
      collection: COLLECTION,
      size: 100,
    });
    expect(schema.sampled).toBe(100);
    const status = schema.fields.find((field) => field.path === 'status');
    expect(status).toEqual({ path: 'status', types: ['string'], presence: 1 });
    expect(schema.fields.find((field) => field.path === '_id')?.types).toEqual(['ObjectId']);
  });

  it('reports the runtime state of a connection', async () => {
    const { api } = connectedApi();
    expect(await api.rpc.shell.state({ connectionId: localConnectionId })).toEqual({
      state: 'stopped',
    });
    await api.rpc.connections.connect({ id: localConnectionId });
    expect(await api.rpc.shell.state({ connectionId: localConnectionId })).toEqual({
      state: 'ready',
    });
  });
  it('reports busy and ready around an evaluation and valid EJSON for every printable', async () => {
    const { api, events } = connectedApi();
    await api.rpc.connections.connect({ id: localConnectionId });
    events.length = 0;
    const printed = await api.rpc.shell.evaluate({
      connectionId: localConnectionId,
      database: DATABASE,
      code: "print('x')",
      batchSize: 50,
    });
    const states = events
      .filter((event) => event.type === 'shell:state')
      .map((event) => (event.type === 'shell:state' ? event.state : undefined));
    expect(states).toEqual(['busy', 'ready']);
    expect(JSON.parse(printed.result?.printableEjson ?? '')).toBeNull();
    const count = await api.rpc.shell.evaluate({
      connectionId: localConnectionId,
      database: DATABASE,
      code: 'db.orders.countDocuments({})',
      batchSize: 50,
    });
    expect(JSON.parse(count.result?.printableEjson ?? '')).toEqual({ $numberInt: '240' });
  });

  it('drops the cursors of a connection when it disconnects', async () => {
    const { api } = connectedApi();
    await api.rpc.connections.connect({ id: localConnectionId });
    const first = await api.rpc.shell.evaluate({
      connectionId: localConnectionId,
      database: DATABASE,
      code: `db.${COLLECTION}.find({})`,
      batchSize: 5,
    });
    await api.rpc.connections.disconnect({ id: localConnectionId });
    await api.rpc.connections.connect({ id: localConnectionId });
    const continued = await api.rpc.shell.next({
      connectionId: localConnectionId,
      requestId: first.requestId,
      batchSize: 5,
    });
    expect(continued.error?.code).toBe('VALIDATION');
  });
});
