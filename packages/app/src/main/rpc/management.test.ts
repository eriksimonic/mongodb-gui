import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as adapter from '@mongo-gui/mongo-adapter';
import {
  AppErrorException,
  appError,
  type AppError,
  type ConnectionProfile,
  type ConnectionStatus,
  type RpcEvent,
  type RpcResult,
} from '@mongo-gui/core';
import {
  createAppServices,
  createRouter,
  type AppServices,
  type ConnectionRegistry,
  type Router,
} from './router';

// The adapter functions are replaced so the router is tested without a driver. Everything else
// in the adapter, including the error helpers, keeps its real behaviour.
vi.mock('@mongo-gui/mongo-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mongo-gui/mongo-adapter')>();
  return {
    ...actual,
    createCollection: vi.fn(),
    renameCollection: vi.fn(),
    dropCollection: vi.fn(),
    clearCollection: vi.fn(),
    createDatabase: vi.fn(),
    dropDatabase: vi.fn(),
    createIndex: vi.fn(),
    dropIndex: vi.fn(),
    setIndexHidden: vi.fn(),
    listIndexBuilds: vi.fn(),
    getValidation: vi.fn(),
    setValidation: vi.fn(),
    checkDocumentsAgainstValidator: vi.fn(),
    insertDocument: vi.fn(),
    replaceDocument: vi.fn(),
    updateDocumentFields: vi.fn(),
    deleteDocuments: vi.fn(),
    deleteByFilter: vi.fn(),
    findDocumentById: vi.fn(),
    sampleDocuments: vi.fn(),
  };
});

type Client = ReturnType<ConnectionRegistry['getClient']>;

const CONNECTION_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const UNKNOWN_CONNECTION_ID = '7d1e9f04-2b3c-4d5e-8f60-a1b2c3d4e5f6';
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
// The adapter is mocked, so the client only has to be a stable object the calls can receive.
const CLIENT = { marker: 'fake client' } as unknown as Client;

function value(result: RpcResult): unknown {
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function failure(result: RpcResult): AppError {
  if (result.ok) {
    throw new Error('expected a failure');
  }
  return result.error;
}

function fakeRegistry(): ConnectionRegistry {
  const statuses = new Map<string, ConnectionStatus>();
  return {
    async connect(profile: ConnectionProfile): Promise<ConnectionStatus> {
      statuses.set(profile.id, { state: 'disconnected' });
      return { state: 'disconnected' };
    },
    async disconnect(connectionId: string) {
      statuses.delete(connectionId);
    },
    async disconnectAll() {
      statuses.clear();
    },
    status(connectionId: string) {
      return statuses.get(connectionId) ?? { state: 'disconnected' };
    },
    getClient(connectionId: string): Client {
      if (connectionId !== CONNECTION_ID) {
        throw new AppErrorException(appError('NOT_CONNECTED', 'Not connected'));
      }
      return CLIENT;
    },
    async test() {
      return { ok: true, serverVersion: '8.0.17', topology: 'standalone' } as const;
    },
    onStatusChange() {
      return () => undefined;
    },
  };
}

describe('management calls through the router', () => {
  let services: AppServices;
  let router: Router;
  let dir: string;
  let events: RpcEvent[];

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'management-router-'));
    services = createAppServices({ userDataDir: dir, kdf: FAST_KDF, failureDelayMs: 0 });
    events = [];
    router = createRouter({
      ...services,
      connections: fakeRegistry(),
      onEvent: (event) => {
        events.push(event);
      },
    });
  });

  afterEach(async () => {
    await services.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs createCollection on the connection client and reports the new collection', async () => {
    const created = { name: 'items', type: 'collection' as const };
    vi.mocked(adapter.createCollection).mockResolvedValue(created);

    const result = await router.handle('management.createCollection', {
      connectionId: CONNECTION_ID,
      database: 'probe',
      name: 'items',
    });

    expect(value(result)).toEqual(created);
    expect(adapter.createCollection).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({ database: 'probe', name: 'items' }),
    );
    expect(events).toEqual([
      {
        type: 'catalog:changed',
        connectionId: CONNECTION_ID,
        database: 'probe',
        collection: 'items',
      },
    ]);
  });

  it('reports only the database after dropDatabase', async () => {
    vi.mocked(adapter.dropDatabase).mockResolvedValue(undefined);

    value(
      await router.handle('management.dropDatabase', {
        connectionId: CONNECTION_ID,
        database: 'probe',
      }),
    );

    expect(events).toEqual([
      { type: 'catalog:changed', connectionId: CONNECTION_ID, database: 'probe' },
    ]);
  });

  it('emits no change when the adapter fails, and keeps the code', async () => {
    vi.mocked(adapter.dropCollection).mockRejectedValue(
      new AppErrorException(appError('COMMAND_FAILED', 'The collection is busy')),
    );

    const error = failure(
      await router.handle('management.dropCollection', {
        connectionId: CONNECTION_ID,
        database: 'probe',
        name: 'items',
      }),
    );

    expect(error).toEqual({ code: 'COMMAND_FAILED', message: 'The collection is busy' });
    expect(events).toEqual([]);
  });

  it('refuses a drop of the _id_ index before the adapter runs', async () => {
    const error = failure(
      await router.handle('management.dropIndex', {
        connectionId: CONNECTION_ID,
        database: 'probe',
        collection: 'items',
        name: '_id_',
      }),
    );

    expect(error.code).toBe('VALIDATION');
    expect(adapter.dropIndex).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('answers NOT_CONNECTED for a connection without a client and does not run the adapter', async () => {
    const error = failure(
      await router.handle('management.dropDatabase', {
        connectionId: UNKNOWN_CONNECTION_ID,
        database: 'probe',
      }),
    );

    expect(error.code).toBe('NOT_CONNECTED');
    expect(adapter.dropDatabase).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('passes the sample size and the draft validator to checkValidation without emitting', async () => {
    const check = { ok: true, errors: [], failingIds: [] };
    vi.mocked(adapter.checkDocumentsAgainstValidator).mockResolvedValue(check);

    const result = await router.handle('management.checkValidation', {
      connectionId: CONNECTION_ID,
      database: 'probe',
      collection: 'items',
      sampleSize: 500,
      validatorEjson: '{"sku":{"$type":"string"}}',
    });

    expect(value(result)).toEqual(check);
    expect(adapter.checkDocumentsAgainstValidator).toHaveBeenCalledWith(
      CLIENT,
      'probe',
      'items',
      500,
      '{"sku":{"$type":"string"}}',
    );
    expect(events).toEqual([]);
  });

  it('scopes the index builds read to the database it is given', async () => {
    vi.mocked(adapter.listIndexBuilds).mockResolvedValue([]);

    value(
      await router.handle('management.listIndexBuilds', {
        connectionId: CONNECTION_ID,
        database: 'probe',
      }),
    );

    expect(adapter.listIndexBuilds).toHaveBeenCalledWith(CLIENT, 'probe');
  });

  it('reports a deleted count for deleteDocuments and a change for the collection', async () => {
    vi.mocked(adapter.deleteDocuments).mockResolvedValue(2);

    const deleted = value(
      await router.handle('management.deleteDocuments', {
        connectionId: CONNECTION_ID,
        database: 'probe',
        collection: 'items',
        idsEjson: ['{"$oid":"64b7f0f0e4b0a1b2c3d4e5f6"}'],
      }),
    );

    expect(deleted).toBe(2);
    expect(events).toEqual([
      {
        type: 'catalog:changed',
        connectionId: CONNECTION_ID,
        database: 'probe',
        collection: 'items',
      },
    ]);
  });

  it('does not emit a change for document sampling', async () => {
    vi.mocked(adapter.sampleDocuments).mockResolvedValue(['{"sku":"A-1"}']);

    const documents = value(
      await router.handle('management.sampleDocuments', {
        connectionId: CONNECTION_ID,
        database: 'probe',
        collection: 'items',
        limit: 20,
      }),
    );

    expect(documents).toEqual(['{"sku":"A-1"}']);
    expect(events).toEqual([]);
  });
});
