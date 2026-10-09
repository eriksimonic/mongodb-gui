import type { ConnectionProfileSummary, ConnectionStatus } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { connectionNodeId, databaseNodeId } from '../../state/node-ids';
import {
  buildTreeRows,
  edgeFocusKey,
  firstChildKey,
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
    ...overrides,
  };
}

describe('buildTreeRows', () => {
  it('lists only the connections when nothing is expanded', () => {
    expect(buildTreeRows(input()).map((row) => row.label)).toEqual(['Local dev', 'Staging']);
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
      '1:shop',
      '2:Profiler',
      '2:orders',
      '1:logs',
      '0:Staging',
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
    expect(rows[1]).toMatchObject({ kind: 'message', label: 'Loading databases' });
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

  it('moves down and up over focusable rows only', () => {
    expect(nextFocusKey(rows, localKey, 1)).toBe(shopKey);
    expect(nextFocusKey(rows, shopKey, -1)).toBe(localKey);
  });

  it('stops at the ends of the list', () => {
    expect(nextFocusKey(rows, localKey, -1)).toBe(localKey);
    expect(edgeFocusKey(rows, 'last')).toBe(connectionNodeId(staging.id));
  });

  it('finds the first child of a parent', () => {
    expect(firstChildKey(rows, localKey)).toBe(shopKey);
    expect(firstChildKey(rows, connectionNodeId(staging.id))).toBeUndefined();
  });
});
