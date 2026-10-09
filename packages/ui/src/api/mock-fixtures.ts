import type {
  CollectionInfo,
  ConnectionProfile,
  DatabaseInfo,
  Favourite,
  HistoryEntry,
  IndexInfo,
} from '@mongo-gui/core';

/** The master password the `unlocked` preset starts with. */
export const mockMasterPassword = 'correct horse battery';

export const localConnectionId = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
export const stagingConnectionId = '7d1e9f04-2b3c-4d5e-8f60-a1b2c3d4e5f6';

const CREATED_AT = '2026-10-01T10:00:00.000Z';
const UPDATED_AT = '2026-10-02T11:30:00.000Z';

export interface CollectionFixture {
  readonly info: CollectionInfo;
  readonly count: number;
}

export interface DatabaseFixture {
  readonly name: string;
  readonly sizeOnDisk: number;
  readonly collections: readonly CollectionFixture[];
}

function plain(name: string, count: number): CollectionFixture {
  return { info: { name, type: 'collection' }, count };
}

const localDatabases: readonly DatabaseFixture[] = [
  {
    name: 'shop',
    sizeOnDisk: 2_097_152,
    collections: [
      plain('orders', 1200),
      plain('customers', 340),
      {
        info: {
          name: 'paid_orders',
          type: 'view',
          options: { viewOn: 'orders', pipeline: [{ $match: { status: 'paid' } }] },
        },
        count: 0,
      },
      {
        info: {
          name: 'sensor_readings',
          type: 'timeseries',
          options: { timeseries: { timeField: 'ts', metaField: 'sensor', granularity: 'seconds' } },
          info: { readOnly: false },
        },
        count: 86_400,
      },
    ],
  },
  {
    name: 'analytics',
    sizeOnDisk: 524_288,
    collections: [plain('events', 5400), plain('sessions', 910)],
  },
  {
    name: 'logs',
    sizeOnDisk: 65_536,
    collections: [plain('app_logs', 150)],
  },
];

const stagingDatabases: readonly DatabaseFixture[] = [
  {
    name: 'shop',
    sizeOnDisk: 8_388_608,
    collections: [plain('orders', 48_000), plain('customers', 9_100)],
  },
  {
    name: 'billing',
    sizeOnDisk: 1_048_576,
    collections: [plain('invoices', 2_300), plain('payments', 2_050)],
  },
  {
    name: 'users',
    sizeOnDisk: 262_144,
    collections: [plain('accounts', 700)],
  },
];

const databasesByConnection: Readonly<Record<string, readonly DatabaseFixture[]>> = {
  [localConnectionId]: localDatabases,
  [stagingConnectionId]: stagingDatabases,
};

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

export function fixtureDatabases(connectionId: string): readonly DatabaseFixture[] {
  return databasesByConnection[connectionId] ?? [];
}

export function databaseInfos(connectionId: string): DatabaseInfo[] {
  return fixtureDatabases(connectionId).map((database) => ({
    name: database.name,
    sizeOnDisk: database.sizeOnDisk,
    empty: database.collections.length === 0,
  }));
}

export function fixtureIndexes(collection: string): IndexInfo[] {
  if (collection === 'orders') {
    return [
      { name: '_id_', key: { _id: 1 }, size: 40_960 },
      {
        name: 'status_1_createdAt_-1',
        key: { status: 1, createdAt: -1 },
        size: 36_864,
        usage: { ops: 412, since: '2026-10-01T00:00:00.000Z' },
      },
    ];
  }
  return [{ name: '_id_', key: { _id: 1 }, size: 20_480 }];
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
