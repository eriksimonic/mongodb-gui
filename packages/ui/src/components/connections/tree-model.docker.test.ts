import type { ConnectionProfileSummary, DockerMongoContainerSummary } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { DOCKER_NODE_ID, connectionNodeId, containerNodeId } from '../../state/node-ids';
import { buildTreeRows, type TreeInput } from './tree-model';

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
