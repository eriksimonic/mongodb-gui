// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeWatchPushState, RpcEvent } from '@mongo-gui/core';
import { localConnectionId } from './mock-fixtures';
import { createMockUiApi } from './mock-rpc-client';
import { MOCK_CHANGE_TICK_MS } from './mock-changes';
import type { UiApi } from './ui-api';

const ORDERS = { kind: 'collection', database: 'shop', collection: 'orders' } as const;

async function startedWatch(): Promise<{ api: UiApi; watchId: string; events: RpcEvent[] }> {
  const api = createMockUiApi({ preset: 'unlocked' });
  await api.rpc.connections.connect({ id: localConnectionId });
  const events: RpcEvent[] = [];
  api.onEvent((event) => events.push(event));
  const { watchId } = await api.rpc.changes.start({
    connectionId: localConnectionId,
    target: ORDERS,
    options: {},
  });
  return { api, watchId, events };
}

/** The event pushes of a watch, flattened in arrival order. */
function eventsOf(events: RpcEvent[], watchId: string) {
  return events.flatMap((event) =>
    event.type === 'changes:event' && event.watchId === watchId ? event.events : [],
  );
}

function statesOf(events: RpcEvent[], watchId: string): ChangeWatchPushState[] {
  return events.flatMap((event) =>
    event.type === 'changes:state' && event.watchId === watchId ? [event.state] : [],
  );
}

describe('mock change streams', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits one synthetic event per tick for the target collection', async () => {
    const { watchId, events } = await startedWatch();

    vi.advanceTimersByTime(MOCK_CHANGE_TICK_MS * 4);

    const received = eventsOf(events, watchId);
    expect(received.map((event) => event.operationType)).toEqual([
      'update',
      'replace',
      'delete',
      'insert',
    ]);
    expect(received.length).toBe(4);
    expect(received.every((event) => event.ns?.coll === 'orders')).toBe(true);
    expect(statesOf(events, watchId)[0]?.phase).toBe('live');
  });

  it('buffers events while paused and sends them in order on resume', async () => {
    const { api, watchId, events } = await startedWatch();
    vi.advanceTimersByTime(MOCK_CHANGE_TICK_MS);
    await api.rpc.changes.pause({ watchId });

    vi.advanceTimersByTime(MOCK_CHANGE_TICK_MS * 3);
    const beforeResume = eventsOf(events, watchId).length;
    await api.rpc.changes.resume({ watchId });

    const phases = statesOf(events, watchId).map((state) => state.phase);
    expect(phases).toEqual(['live', 'paused', 'resuming', 'live']);
    expect(eventsOf(events, watchId)).toHaveLength(beforeResume + 3);
    expect(await api.rpc.changes.state({ watchId })).toMatchObject({ phase: 'live' });
  });

  it('refuses $out and $merge with the adapter message', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.connections.connect({ id: localConnectionId });

    await expect(
      api.rpc.changes.start({
        connectionId: localConnectionId,
        target: ORDERS,
        options: { pipelineEjson: '[{"$match": {}}, {"$merge": {"into": "archive"}}]' },
      }),
    ).rejects.toMatchObject({ message: '$merge is not allowed in a change stream pipeline' });
  });

  it('sends an invalidate and closes the watch when the target collection is dropped', async () => {
    const { api, watchId, events } = await startedWatch();
    vi.advanceTimersByTime(MOCK_CHANGE_TICK_MS);

    await api.rpc.management.dropCollection({
      connectionId: localConnectionId,
      database: 'shop',
      name: 'orders',
    });
    vi.advanceTimersByTime(MOCK_CHANGE_TICK_MS);

    const last = eventsOf(events, watchId).at(-1);
    expect(last?.operationType).toBe('invalidate');
    expect(statesOf(events, watchId).at(-1)?.phase).toBe('closed');
  });
});
