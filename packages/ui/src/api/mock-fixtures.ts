import type {
  ConnectionProfile,
  DockerMongoContainerSummary,
  Favourite,
  HistoryEntry,
} from '@mongo-gui/core';

/** The master password the `unlocked` preset starts with. */
export const mockMasterPassword = 'correct horse battery';

export const localConnectionId = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
export const stagingConnectionId = '7d1e9f04-2b3c-4d5e-8f60-a1b2c3d4e5f6';

const CREATED_AT = '2026-10-01T10:00:00.000Z';
const UPDATED_AT = '2026-10-02T11:30:00.000Z';

export function fixtureConnections(): ConnectionProfile[] {
  return [
    {
      id: localConnectionId,
      name: 'Local dev',
      color: '#3b82f6',
      uri: 'mongodb://app:secret@localhost:27017/?authSource=admin',
      readPreference: 'primary',
      connectTimeoutMs: 5000,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    {
      id: stagingConnectionId,
      name: 'Staging',
      color: '#f59e0b',
      uri: 'mongodb+srv://ops:hunter2@cluster0.example.net/?retryWrites=true',
      tls: { enabled: true },
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
    },
  ];
}

export function fixtureHistory(): HistoryEntry[] {
  return [
    {
      id: '9b1d4c7a-2e3f-4a6b-8c9d-0e1f2a3b4c5d',
      connectionId: localConnectionId,
      database: 'shop',
      code: 'db.orders.find({ status: "paid" }).limit(50)',
      startedAt: '2026-10-05T08:15:00.000Z',
      durationMs: 42,
      resultCount: 50,
    },
    {
      id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      connectionId: localConnectionId,
      database: 'analytics',
      code: 'db.events.countDocuments({})',
      startedAt: '2026-10-05T08:20:00.000Z',
      durationMs: 9,
      resultCount: 1,
    },
  ];
}

export function fixtureFavourites(): Favourite[] {
  return [
    {
      id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      name: 'Paid orders',
      folder: 'Orders',
      code: 'db.orders.find({ status: "paid" })',
      connectionId: localConnectionId,
      database: 'shop',
      createdAt: CREATED_AT,
    },
  ];
}

/** A container with 27017 published on loopback. Its root user is `app`, with a password the mock never shows. */
export function fixtureDockerContainers(): DockerMongoContainerSummary[] {
  return [
    {
      id: '6c1e0b9d4f2a7e83c5d1b0a9f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6b',
      name: 'shop-mongo',
      image: 'mongo:7',
      state: 'running',
      publishedPort: { hostIp: '127.0.0.1', hostPort: 27017 },
      internalPort: 27017,
      networks: ['shop_default'],
      env: { username: 'app', database: 'shop' },
      envKeys: [
        'MONGO_INITDB_DATABASE',
        'MONGO_INITDB_ROOT_PASSWORD',
        'MONGO_INITDB_ROOT_USERNAME',
      ],
      hasCredentials: true,
    },
    {
      id: '9d4a7b2c8e1f0a3b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b',
      name: 'orders-mongo',
      image: 'mongo:8.0.17',
      state: 'running',
      internalPort: 27017,
      networks: ['orders_net'],
      env: {},
      envKeys: ['MONGO_VERSION'],
      hasCredentials: false,
    },
  ];
}

/** The saved profile of the shop-mongo container. It is connected in the unlocked preset. */
export const DOCKER_PROFILE_ID = '0d6f3b2a-9c1e-4f7a-8b5d-2e4c6a1f9b30';

export function fixtureDockerProfile(): ConnectionProfile {
  return {
    id: DOCKER_PROFILE_ID,
    name: 'shop-mongo',
    uri: 'mongodb://app:secret@localhost:27017/?authSource=admin&directConnection=true',
    source: 'docker',
    dockerContainerId: '6c1e0b9d4f2a7e83c5d1b0a9f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6b',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}
