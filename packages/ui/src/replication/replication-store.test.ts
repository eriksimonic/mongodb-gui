import { describe, expect, it, vi } from 'vitest';
import { AppErrorException, appError } from '@mongo-gui/core';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import { createReplicationStore } from './replication-store';

async function replicaSetApi(): Promise<UiApi> {
  const api = createMockUiApi({ preset: 'unlocked', replication: true });
  await api.rpc.connections.connect({ id: localConnectionId });
  return api;
}

const ADD_ARBITER = {
  kind: 'add' as const,
  member: { host: 'localhost:27020', arbiterOnly: true, priority: 0, votes: 1 },
};

describe('replication store', () => {
  it('loads the status and the configuration of the set', async () => {
    const store = createReplicationStore(await replicaSetApi(), localConnectionId);
    await store.getState().refresh();
    const state = store.getState();
    expect(state.status?.setName).toBe('rs0');
    expect(state.status?.primary).toBe('localhost:27017');
    expect(state.status?.members).toHaveLength(3);
    expect(state.config?.version).toBe(4);
    expect(state.error).toBeUndefined();
    expect(state.loading).toBe(false);
  });

  it('keeps the error of a node that has no configuration yet', async () => {
    const api = createMockUiApi({ preset: 'unlocked', replSetUninitiated: true });
    await api.rpc.connections.connect({ id: localConnectionId });
    const store = createReplicationStore(api, localConnectionId);
    await store.getState().refresh();
    expect(store.getState().status).toBeUndefined();
    expect(store.getState().error?.detail).toMatch(/no replset config/);
  });

  it('steps the primary down and reads the new primary back', async () => {
    const store = createReplicationStore(await replicaSetApi(), localConnectionId);
    await store.getState().refresh();
    const primary = await store.getState().stepDown(30);
    expect(primary).toBe('localhost:27018');
    expect(store.getState().status?.primary).toBe('localhost:27018');
  });

  it('plans a change and keeps the plan until it is applied', async () => {
    const store = createReplicationStore(await replicaSetApi(), localConnectionId);
    await store.getState().refresh();
    const plan = await store.getState().planChange(ADD_ARBITER);
    expect(plan.refused).toBeUndefined();
    expect(plan.changes.join(' ')).toContain('Add localhost:27020');
    expect(store.getState().pending?.plan).toEqual(plan);

    await store.getState().applyPlan();
    expect(store.getState().pending).toBeUndefined();
    expect(store.getState().config?.version).toBe(5);
    expect(store.getState().status?.members).toHaveLength(4);
  });

  it('keeps a refused plan and refuses to apply it', async () => {
    const store = createReplicationStore(await replicaSetApi(), localConnectionId);
    await store.getState().refresh();
    const plan = await store.getState().planChange({
      kind: 'add',
      member: { host: 'localhost:27018' },
    });
    expect(plan.refused).toMatch(/already a member/);
    await expect(store.getState().applyPlan()).rejects.toMatchObject({
      error: { code: 'VALIDATION' },
    });
    expect(store.getState().config?.version).toBe(4);
    expect(store.getState().stale).toBe(false);
  });

  it('marks a plan stale when another change moved the version, and refreshes on request', async () => {
    const api = await replicaSetApi();
    const store = createReplicationStore(api, localConnectionId);
    await store.getState().refresh();
    await store.getState().planChange(ADD_ARBITER);

    // Another client reconfigures the set first.
    const other = createReplicationStore(api, localConnectionId);
    await other.getState().planChange({ kind: 'update', memberId: 1, patch: { priority: 3 } });
    await other.getState().applyPlan();

    await expect(store.getState().applyPlan()).rejects.toMatchObject({
      error: { code: 'VALIDATION' },
    });
    expect(store.getState().stale).toBe(true);
    expect(store.getState().pending).toBeUndefined();

    await store.getState().refresh();
    store.getState().clearPlan();
    expect(store.getState().config?.version).toBe(5);
    expect(store.getState().stale).toBe(false);
  });

  it('initiates a set on a node started with --replSet', async () => {
    const api = createMockUiApi({ preset: 'unlocked', replSetUninitiated: true });
    await api.rpc.connections.connect({ id: localConnectionId });
    const store = createReplicationStore(api, localConnectionId);
    await store.getState().refresh();
    await store.getState().initiate({ setName: 'rs1', members: [{ host: 'localhost:27017' }] });
    expect(store.getState().status?.setName).toBe('rs1');
    expect(store.getState().error).toBeUndefined();
  });

  it('turns the auto refresh flag on and off', async () => {
    const store = createReplicationStore(await replicaSetApi(), localConnectionId);
    store.getState().setAutoRefresh(true);
    expect(store.getState().autoRefresh).toBe(true);
    store.getState().setAutoRefresh(false);
    expect(store.getState().autoRefresh).toBe(false);
  });

  it('marks the status stale when a read fails and refuses changes until a read succeeds', async () => {
    const api = await replicaSetApi();
    const store = createReplicationStore(api, localConnectionId);
    await store.getState().refresh();
    const before = store.getState().status;

    vi.spyOn(api.rpc.replication, 'getStatus').mockRejectedValueOnce(
      new AppErrorException(appError('CONNECTION_FAILED', 'Could not connect to the server')),
    );
    await store.getState().refresh();
    expect(store.getState().statusStale).toBe(true);
    expect(store.getState().error?.code).toBe('CONNECTION_FAILED');
    expect(store.getState().status).toBe(before);

    const stepDown = vi.spyOn(api.rpc.replication, 'stepDown');
    await expect(store.getState().stepDown(60)).rejects.toMatchObject({
      error: { code: 'VALIDATION' },
    });
    await expect(store.getState().freeze(10)).rejects.toMatchObject({
      error: { code: 'VALIDATION' },
    });
    await expect(store.getState().planChange(ADD_ARBITER)).rejects.toMatchObject({
      error: { code: 'VALIDATION' },
    });
    expect(stepDown).not.toHaveBeenCalled();

    await store.getState().refresh();
    expect(store.getState().statusStale).toBe(false);
    expect(store.getState().error).toBeUndefined();
  });

  it('reads the host the node names itself by', async () => {
    const store = createReplicationStore(await replicaSetApi(), localConnectionId);
    await store.getState().loadSelfHost();
    expect(store.getState().selfHost).toBe('localhost:27017');
  });
});
