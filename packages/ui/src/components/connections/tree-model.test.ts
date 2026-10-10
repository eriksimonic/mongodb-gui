import type { ConnectionProfileSummary, ConnectionStatus } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import {
  DOCKER_NODE_ID,
  connectionNodeId,
  databaseNodeId,
  monitorNodeId,
  operationsNodeId,
} from '../../state/node-ids';
import {
  buildTreeRows,
  edgeFocusKey,
  firstChildKey,
  memberStateTone,
  nextFocusKey,
  parentKeyOf,
  type TreeInput,
} from './tree-model';

const local: ConnectionProfileSummary = {
  id: '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10',
  name: 'Local dev',
  color: '#3b82f6',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  uriRedacted: 'mongodb://app:***@localhost/',
};
const staging: ConnectionProfileSummary = {
  ...local,
  id: '7d1e9f04-2b3c-4d5e-8f60-a1b2c3d4e5f6',
  name: 'Staging',
  color: undefined,
};

const connected: ConnectionStatus = {
  state: 'connected',
  serverVersion: '8.0.4',
  topology: 'standalone',
  hosts: [],
};

function input(overrides: Partial<TreeInput> = {}): TreeInput {
  return {
    connections: [local, staging],
    statuses: {},
    expanded: {},
    databases: {},
    collections: {},
    docker: {
      status: { available: true, engineVersion: '29.8.2' },
      containers: { state: 'ready', data: [] },
    },
    ...overrides,
  };
}

describe('buildTreeRows replica set rows', () => {
  const member = {
    id: 0,
    name: 'a:27117',
    state: 'PRIMARY',
    stateCode: 1,
    health: 1,
    self: true,
    priority: 1,
    votes: 1,
    hidden: false,
    arbiterOnly: false,
    buildIndexes: true,
    secondaryDelaySecs: 0,
    tags: {},
  };
  const replicaStatus = { ...connected, topology: 'replicaSet' as const, setName: 'rs0' };

  it('lists the set node with its members under a connected replica set member', () => {
    const rows = buildTreeRows(
      input({
        expanded: { [connectionNodeId(local.id)]: true },
        statuses: { [local.id]: replicaStatus },
        databases: { [local.id]: { state: 'ready', data: [] } },
        replicaSets: {
          [local.id]: {
            state: 'ready',
            data: {
              setName: 'rs0',
              myState: 1,
              members: [
                member,
                {
                  ...member,
                  id: 1,
                  name: 'b:27118',
                  state: 'SECONDARY',
                  stateCode: 2,
                  self: false,
                },
              ],
            },
          },
        },
      }),
    );
    const labels = rows.map((row) => row.label);
    expect(labels.slice(0, 4)).toEqual(['Local dev', 'Replica set rs0', 'a:27117', 'b:27118']);
    expect(rows[2]).toMatchObject({ kind: 'member', depth: 2, note: 'PRIMARY · this connection' });
    expect(rows[3]).toMatchObject({ kind: 'member', note: 'SECONDARY' });
  });

  it('shows a loading line until the members arrive, and nothing for a standalone server', () => {
    const loading = buildTreeRows(
      input({
        expanded: { [connectionNodeId(local.id)]: true },
        statuses: { [local.id]: replicaStatus },
        databases: { [local.id]: { state: 'ready', data: [] } },
      }),
    );
    expect(loading.map((row) => row.label).slice(1, 3)).toEqual([
      'Replica set rs0',
      'Loading members',
    ]);

    const standalone = buildTreeRows(
      input({
        expanded: { [connectionNodeId(local.id)]: true },
        statuses: { [local.id]: connected },
        databases: { [local.id]: { state: 'ready', data: [] } },
      }),
    );
    expect(standalone.map((row) => row.label)).not.toContain('Replica set rs0');
  });

  it('colours a member by its state and marks an unhealthy one as down', () => {
    expect(memberStateTone({ state: 'PRIMARY', health: 1 })).toBe('primary');
    expect(memberStateTone({ state: 'SECONDARY', health: 1 })).toBe('secondary');
    expect(memberStateTone({ state: 'ARBITER', health: 1 })).toBe('arbiter');
    expect(memberStateTone({ state: 'SECONDARY', health: 0 })).toBe('down');
    expect(memberStateTone({ state: 'RECOVERING', health: 1 })).toBe('down');
  });
});

describe('buildTreeRows', () => {
  it('lists the connections, then the Docker node, when nothing is expanded', () => {
    expect(buildTreeRows(input()).map((row) => row.label)).toEqual([
      'Local dev',
      'Staging',
      'Docker',
      'No MongoDB containers found',
    ]);
  });

  it('shows a not-connected hint under an expanded disconnected connection', () => {
    const rows = buildTreeRows(input({ expanded: { [connectionNodeId(local.id)]: true } }));
    expect(rows[1]).toMatchObject({
      kind: 'message',
      depth: 1,
      label: 'Not connected. Double-click to connect.',
    });
  });

  it('shows the error message in red under a failed connection', () => {
    const rows = buildTreeRows(
      input({
        expanded: { [connectionNodeId(staging.id)]: true },
        statuses: {
          [staging.id]: {
            state: 'error',
            error: { code: 'AUTH_FAILED', message: 'Authentication failed' },
          },
        },
      }),
    );
    const message = rows.find((row) => row.kind === 'message');
    expect(message).toMatchObject({ label: 'Authentication failed', tone: 'red' });
  });

  it('lists databases and their collections once loaded', () => {
    const rows = buildTreeRows(
      input({
        expanded: { [connectionNodeId(local.id)]: true, [databaseNodeId(local.id, 'shop')]: true },
        statuses: { [local.id]: connected },
        databases: {
          [local.id]: { state: 'ready', data: [{ name: 'shop' }, { name: 'logs' }] },
        },
        collections: {
          [`${local.id}/shop`]: {
            state: 'ready',
            data: [{ name: 'orders', type: 'collection' }],
          },
        },
      }),
    );
    expect(rows.map((row) => `${row.depth}:${row.label}`)).toEqual([
      '0:Local dev',
      '1:Monitoring',
      '1:Operations',
      '1:shop',
      '2:Profiler',
      '2:GridFS',
      '2:orders',
      '1:logs',
      '0:Staging',
      '0:Docker',
      '1:No MongoDB containers found',
    ]);
    expect(parentKeyOf(rows, 'col:' + local.id + '/shop/orders')).toBe(
      databaseNodeId(local.id, 'shop'),
    );
  });

  it('shows a loading line while databases are pending', () => {
    const rows = buildTreeRows(
      input({
        expanded: { [connectionNodeId(local.id)]: true },
        statuses: { [local.id]: connected },
        databases: { [local.id]: { state: 'loading' } },
      }),
    );
    expect(rows[3]).toMatchObject({ kind: 'message', label: 'Loading databases' });
  });

  it('adds Monitoring and Operations under a connected connection only', () => {
    const connectedRows = buildTreeRows(
      input({
        statuses: { [local.id]: connected },
        expanded: { [connectionNodeId(local.id)]: true },
      }),
    );
    expect(connectedRows[1]).toMatchObject({
      kind: 'monitor',
      label: 'Monitoring',
      key: monitorNodeId(local.id),
      parentKey: connectionNodeId(local.id),
    });
    expect(connectedRows[2]).toMatchObject({ kind: 'operations', label: 'Operations' });

    const disconnectedRows = buildTreeRows(
      input({ expanded: { [connectionNodeId(local.id)]: true } }),
    );
    expect(disconnectedRows.some((row) => row.kind === 'monitor')).toBe(false);
  });
});

describe('keyboard movement helpers', () => {
  const rows = buildTreeRows(
    input({
      expanded: { [connectionNodeId(local.id)]: true, [databaseNodeId(local.id, 'shop')]: true },
      statuses: { [local.id]: connected },
      databases: { [local.id]: { state: 'ready', data: [{ name: 'shop' }] } },
      collections: {
        [`${local.id}/shop`]: { state: 'ready', data: [{ name: 'orders', type: 'collection' }] },
      },
    }),
  );
  const localKey = connectionNodeId(local.id);
  const shopKey = databaseNodeId(local.id, 'shop');
  const monitorKey = monitorNodeId(local.id);
  const operationsKey = operationsNodeId(local.id);

  it('moves down and up over focusable rows only', () => {
    expect(nextFocusKey(rows, localKey, 1)).toBe(monitorKey);
    expect(nextFocusKey(rows, operationsKey, 1)).toBe(shopKey);
    expect(nextFocusKey(rows, shopKey, -1)).toBe(operationsKey);
  });

  it('stops at the ends of the list', () => {
    expect(nextFocusKey(rows, localKey, -1)).toBe(localKey);
    expect(edgeFocusKey(rows, 'last')).toBe(DOCKER_NODE_ID);
  });

  it('finds the first child of a parent', () => {
    expect(firstChildKey(rows, localKey)).toBe(monitorKey);
    expect(firstChildKey(rows, connectionNodeId(staging.id))).toBeUndefined();
  });
});
