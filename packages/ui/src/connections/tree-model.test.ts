import type {
  ConnectionProfileSummary,
  ConnectionStatus,
  DockerMongoContainerSummary,
  GridFsBucket,
} from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import {
  catalogKey,
  connectionNodeId,
  containerNodeId,
  databaseNodeId,
  DOCKER_NODE_ID,
  gridfsBucketNodeId,
  gridfsNodeId,
  monitorNodeId,
  operationsNodeId,
} from '../state/node-ids';
import {
  buildTreeRows,
  edgeFocusKey,
  filterTreeRows,
  firstChildKey,
  memberStateTone,
  nextFocusKey,
  parentKeyOf,
  type TreeInput,
  type TreeRow,
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

  it('does not open a disconnected connection', () => {
    const rows = buildTreeRows(input({ expanded: { [connectionNodeId(local.id)]: true } }));
    expect(rows[0]).toMatchObject({ kind: 'connection', expandable: false, expanded: false });
    expect(rows[1]?.kind).not.toBe('message');
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

describe('filterTreeRows', () => {
  it('hides non-matching children of the parent with their descendants and keeps other rows', () => {
    const rows = buildTreeRows(
      input({
        statuses: { [local.id]: connected, [staging.id]: connected },
        expanded: { [connectionNodeId(local.id)]: true, [connectionNodeId(staging.id)]: true },
        databases: {
          [local.id]: { state: 'ready', data: [{ name: 'shop' }, { name: 'perf' }] },
          [staging.id]: { state: 'ready', data: [{ name: 'shop' }] },
        },
      } as Partial<TreeInput>),
    );
    const parentKey = connectionNodeId(local.id);
    const labels = filterTreeRows(rows, { parentKey, text: 'PE' }).map((row) => row.label);
    expect(labels).toContain('perf');
    expect(labels.filter((label) => label === 'Monitoring')).toHaveLength(1);
    expect(labels.filter((label) => label === 'shop')).toHaveLength(1);
    expect(labels).toContain('Staging');
  });
});

const shop: DockerMongoContainerSummary = {
  id: 'c0ffee',
  name: 'shop-mongo',
  image: 'mongo:7',
  state: 'running',
  publishedPort: { hostIp: '127.0.0.1', hostPort: 27017 },
  internalPort: 27017,
  networks: ['shop_default'],
  env: { username: 'app' },
  envKeys: ['MONGO_INITDB_ROOT_PASSWORD'],
  hasCredentials: true,
};

const orders: DockerMongoContainerSummary = {
  ...shop,
  id: 'deadbeef',
  name: 'orders-mongo',
  image: 'mongo:8.0.17',
  publishedPort: undefined,
  env: {},
  envKeys: [],
  hasCredentials: false,
};

const linked: ConnectionProfileSummary = {
  id: '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10',
  name: 'shop-mongo',
  source: 'docker',
  dockerContainerId: shop.id,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  uriRedacted: 'mongodb://app:***@localhost:27017/',
};

const manual: ConnectionProfileSummary = {
  ...linked,
  id: '7d1e9f04-2b3c-4d5e-8f60-a1b2c3d4e5f6',
  name: 'Staging',
  source: undefined,
  dockerContainerId: undefined,
};

function dockerInput(overrides: Partial<TreeInput> = {}): TreeInput {
  return {
    connections: [manual, linked],
    statuses: {},
    expanded: {},
    databases: {},
    collections: {},
    docker: {
      status: { available: true, engineVersion: '29.8.2' },
      containers: { state: 'ready', data: [shop, orders] },
    },
    ...overrides,
  };
}

describe('buildTreeRows for the Docker node', () => {
  it('puts docker-sourced connections under their container, not at the top', () => {
    const rows = buildTreeRows(dockerInput());

    expect(rows.filter((row) => row.depth === 0).map((row) => row.label)).toEqual([
      'Staging',
      'Docker',
    ]);
    expect(rows.find((row) => row.label === 'shop-mongo')).toMatchObject({
      kind: 'connection',
      depth: 1,
      parentKey: DOCKER_NODE_ID,
      connectionId: linked.id,
    });
  });

  it('lists containers without a connection as container rows', () => {
    const row = buildTreeRows(dockerInput()).find((item) => item.label === 'orders-mongo');

    expect(row).toMatchObject({
      key: containerNodeId(orders.id),
      kind: 'container',
      depth: 1,
      parentKey: DOCKER_NODE_ID,
      container: orders,
    });
  });

  it('hides the containers when the node is collapsed', () => {
    const rows = buildTreeRows(dockerInput({ expanded: { [DOCKER_NODE_ID]: false } }));

    expect(rows.map((row) => row.label)).toEqual(['Staging', 'Docker']);
  });

  it('opens a docker connection with its databases like any other connection', () => {
    const rows = buildTreeRows(
      dockerInput({
        expanded: { [connectionNodeId(linked.id)]: true },
        statuses: { [linked.id]: { state: 'connecting' } },
      }),
    );

    expect(rows.find((row) => row.label === 'Connecting')).toMatchObject({
      kind: 'message',
      depth: 2,
    });
  });

  it('shows the engine reason when Docker is not available, and keeps the profiles visible', () => {
    const rows = buildTreeRows(
      dockerInput({
        docker: {
          status: {
            available: false,
            reason: 'Docker is not reachable at /var/run/docker.sock (ENOENT).',
          },
          containers: { state: 'ready', data: [] },
        },
      }),
    );

    expect(rows.slice(-3).map((row) => row.label)).toEqual([
      'Docker not available',
      'Docker is not reachable at /var/run/docker.sock (ENOENT).',
      'shop-mongo',
    ]);
    expect(rows.find((row) => row.label === 'shop-mongo')).toMatchObject({
      note: 'Docker not reachable',
      depth: 1,
    });
  });

  it('shows a checking line before the Docker state is read', () => {
    const rows = buildTreeRows(dockerInput({ docker: undefined }));

    expect(rows.find((row) => row.label === 'Checking Docker')).toMatchObject({
      kind: 'message',
      depth: 1,
    });
  });

  it('keeps a profile whose container is gone, and marks it missing', () => {
    const rows = buildTreeRows(
      dockerInput({
        docker: {
          status: { available: true },
          containers: { state: 'ready', data: [orders] },
        },
      }),
    );

    expect(rows.find((row) => row.label === 'shop-mongo')).toMatchObject({
      kind: 'connection',
      expandable: false,
      container: undefined,
    });
    expect(rows.find((row) => row.label === 'Container not found')).toMatchObject({
      kind: 'message',
      tone: 'red',
    });
  });

  it('shows the error when the container list fails', () => {
    const rows = buildTreeRows(
      dockerInput({
        docker: {
          status: { available: true },
          containers: {
            state: 'error',
            error: { code: 'INTERNAL', message: 'Docker did not respond in time.' },
          },
        },
      }),
    );

    expect(rows.find((row) => row.label === 'Docker did not respond in time.')).toMatchObject({
      kind: 'message',
      tone: 'red',
    });
  });
});

const connection: ConnectionProfileSummary = {
  id: '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10',
  name: 'Local dev',
  color: undefined,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  uriRedacted: 'mongodb://app:***@localhost/',
};

const receipts: GridFsBucket = {
  name: 'receipts',
  filesCollection: 'receipts.files',
  chunksCollection: 'receipts.chunks',
  fileCount: 4,
  totalBytes: 355_000,
};

function treeWith(gridfsExpanded: boolean, buckets: TreeInput['gridfs']): TreeRow[] {
  return buildTreeRows({
    connections: [connection],
    statuses: { [connection.id]: connected },
    expanded: {
      [connectionNodeId(connection.id)]: true,
      [databaseNodeId(connection.id, 'shop')]: true,
      ...(gridfsExpanded ? { [gridfsNodeId(connection.id, 'shop')]: true } : {}),
    },
    databases: {
      [connection.id]: { state: 'ready', data: [{ name: 'shop', sizeOnDisk: 0, empty: false }] },
    },
    collections: {},
    gridfs: buckets,
  });
}

describe('tree rows for GridFS', () => {
  it('shows a GridFS node under an open database, collapsed by default', () => {
    const rows = treeWith(false, {});
    const node = rows.find((row) => row.kind === 'gridfs');

    expect(node).toMatchObject({ label: 'GridFS', expandable: true, expanded: false });
    expect(node?.key).toBe(gridfsNodeId(connection.id, 'shop'));
    expect(rows.some((row) => row.kind === 'gridfs-bucket')).toBe(false);
  });

  it('lists each bucket with its file count and total size under the open node', () => {
    const rows = treeWith(true, {
      [catalogKey(connection.id, 'shop')]: { state: 'ready', data: [receipts] },
    });
    const bucket = rows.find((row) => row.kind === 'gridfs-bucket');

    expect(bucket).toMatchObject({
      key: gridfsBucketNodeId(connection.id, 'shop', 'receipts'),
      label: 'receipts · 4 files · 346.7 KiB',
      bucket: 'receipts',
      database: 'shop',
      depth: 3,
    });
  });

  it('says so when the database has no buckets, and while they load', () => {
    const empty = treeWith(true, {
      [catalogKey(connection.id, 'shop')]: { state: 'ready', data: [] },
    });
    expect(empty.some((row) => row.label === 'No buckets')).toBe(true);

    const loading = treeWith(true, {});
    expect(loading.some((row) => row.label === 'Loading buckets')).toBe(true);
  });
});
