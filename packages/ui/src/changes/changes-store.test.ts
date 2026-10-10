import { appError, type ChangeEvent, type ChangeWatchState, type RpcClient } from '@mongo-gui/core';
import { describe, expect, it, vi } from 'vitest';
import type { UiApi } from '../api/ui-api';
import { createChangesStore, type ChangesStore } from './changes-store';

const PANEL = 'changes:test';
const TARGET = { kind: 'collection', database: 'shop', collection: 'orders' } as const;
const CONNECTION = '11111111-1111-4111-8111-111111111111';

/** A backend with spies on the change calls. The first start answers watch-1. */
function fakeApi() {
  const changes = {
    start: vi.fn(async () => ({ watchId: 'watch-1' })),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    state: vi.fn(async (): Promise<ChangeWatchState> => ({
      phase: 'live',
      eventsSeen: 0,
      eventsDropped: 0,
      openedAt: '2026-10-10T10:00:00.000Z',
    })),
  };
  const api = {
    rpc: { changes } as unknown as RpcClient,
    onEvent: () => () => undefined,
  } satisfies UiApi;
  return { api, changes };
}

function eventOf(id: number): ChangeEvent {
  return {
    id: String(id),
    operationType: 'insert',
    resumeTokenEjson: `{"_data":"${id}"}`,
    sizeBytes: 64,
    rawEjson: `{"_id":{"_data":"${id}"}}`,
    ns: { db: 'shop', coll: 'orders' },
    wallTime: '2026-10-10T10:00:00.000Z',
  };
}

function batch(watchId: string, first: number, count: number) {
  const events = Array.from({ length: count }, (_, index) => eventOf(first + index));
  return { type: 'changes:event' as const, watchId, events };
}

function openStore(api: UiApi): ChangesStore {
  const store = createChangesStore(api);
  store.getState().open(PANEL, CONNECTION, TARGET);
  return store;
}

describe('changes store', () => {
  it('appends batches and keeps the newest 5000 rows, counting the rows it trims', async () => {
    const { api } = fakeApi();
    const store = openStore(api);
    await store.getState().start(PANEL);

    for (let index = 0; index < 110; index += 1) {
      store.getState().applyEvent(batch('watch-1', index * 50 + 1, 50));
    }

    const panel = store.getState().panels[PANEL];
    expect(panel?.rows).toHaveLength(5000);
    expect(panel?.trimmed).toBe(500);
    expect(panel?.rows[0]?.event.id).toBe('501');
    expect(panel?.rows.at(-1)?.event.id).toBe('5500');
    expect(panel?.eventsSeen).toBe(5500);
  });

  it('ignores events of a watch the panel does not own', async () => {
    const { api } = fakeApi();
    const store = openStore(api);
    await store.getState().start(PANEL);

    store.getState().applyEvent(batch('watch-other', 1, 3));

    expect(store.getState().panels[PANEL]?.rows).toHaveLength(0);
  });

  it('pauses and resumes the watch and shows the phase the server reports', async () => {
    const { api, changes } = fakeApi();
    const store = openStore(api);
    await store.getState().start(PANEL);

    changes.state.mockResolvedValueOnce({
      phase: 'paused',
      eventsSeen: 4,
      eventsDropped: 0,
      openedAt: '2026-10-10T10:00:00.000Z',
    });
    await store.getState().pause(PANEL);
    expect(changes.pause).toHaveBeenCalledWith({ watchId: 'watch-1' });
    expect(store.getState().panels[PANEL]?.phase).toBe('paused');

    await store.getState().resume(PANEL);
    expect(changes.resume).toHaveBeenCalledWith({ watchId: 'watch-1' });
    expect(store.getState().panels[PANEL]?.phase).toBe('live');
  });

  it('restarts from the token of a row and drops the rows after it', async () => {
    const { api, changes } = fakeApi();
    const store = openStore(api);
    await store.getState().start(PANEL);
    store.getState().applyEvent(batch('watch-1', 1, 4));
    changes.start.mockResolvedValueOnce({ watchId: 'watch-2' });

    await store.getState().resumeFrom(PANEL, 'watch-1:2');

    const panel = store.getState().panels[PANEL];
    expect(changes.stop).toHaveBeenCalledWith({ watchId: 'watch-1' });
    expect(changes.start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ resumeAfterEjson: '{"_data":"2"}' }),
      }),
    );
    expect(panel?.rows.map((row) => row.event.id)).toEqual(['1', '2']);
    expect(panel?.resumeToken).toBe('{"_data":"2"}');
    expect(panel?.watchId).toBe('watch-2');
  });

  it('keeps one live watch when two restarts overlap, and stops the one that was superseded', async () => {
    const { api, changes } = fakeApi();
    const store = openStore(api);
    await store.getState().start(PANEL);
    store.getState().applyEvent(batch('watch-1', 1, 3));
    const answers: ((value: { watchId: string }) => void)[] = [];
    changes.start.mockImplementation(
      () => new Promise<{ watchId: string }>((resolve) => answers.push(resolve)),
    );

    const first = store.getState().resumeFrom(PANEL, 'watch-1:2');
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    const second = store.getState().resumeFrom(PANEL, 'watch-1:2');
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[0]?.({ watchId: 'watch-a' });
    answers[1]?.({ watchId: 'watch-b' });
    await Promise.all([first, second]);

    expect(store.getState().panels[PANEL]?.watchId).toBe('watch-b');
    expect(changes.stop).toHaveBeenCalledWith({ watchId: 'watch-a' });
    expect(changes.stop).not.toHaveBeenCalledWith({ watchId: 'watch-b' });
  });

  it('stops a start that resolves after the panel was stopped', async () => {
    const { api, changes } = fakeApi();
    const store = openStore(api);
    let answer: ((value: { watchId: string }) => void) | undefined;
    changes.start.mockImplementation(
      () => new Promise<{ watchId: string }>((resolve) => (answer = resolve)),
    );

    const starting = store.getState().start(PANEL);
    await vi.waitFor(() => expect(answer).toBeDefined());
    await store.getState().stop(PANEL);
    answer?.({ watchId: 'watch-late' });
    await starting;

    expect(store.getState().panels[PANEL]?.watchId).toBeUndefined();
    expect(changes.stop).toHaveBeenCalledWith({ watchId: 'watch-late' });
  });

  it('stops the watch when the panel closes', async () => {
    const { api, changes } = fakeApi();
    const store = openStore(api);
    await store.getState().start(PANEL);

    await store.getState().close(PANEL);

    expect(changes.stop).toHaveBeenCalledWith({ watchId: 'watch-1' });
    expect(store.getState().panels[PANEL]).toBeUndefined();
  });

  it('refuses a pipeline that is not an array without calling the server', async () => {
    const { api, changes } = fakeApi();
    const store = openStore(api);
    store.getState().setPipeline(PANEL, '{"$match": {}}');

    await store.getState().start(PANEL);

    expect(changes.start).not.toHaveBeenCalled();
    expect(store.getState().panels[PANEL]?.pipelineError).toBe(
      'The pipeline must be an array of stages.',
    );
  });

  it('shows the phase and error that a state push reports', async () => {
    const { api } = fakeApi();
    const store = openStore(api);
    await store.getState().start(PANEL);

    store.getState().applyEvent({
      type: 'changes:state',
      watchId: 'watch-1',
      state: {
        phase: 'error',
        eventsSeen: 3,
        eventsDropped: 0,
        error: appError('NOT_CONNECTED', 'The connection closed.'),
      },
    });

    const panel = store.getState().panels[PANEL];
    expect(panel?.phase).toBe('error');
    expect(panel?.error?.message).toBe('The connection closed.');
    expect(panel?.eventsSeen).toBe(3);
  });
});
