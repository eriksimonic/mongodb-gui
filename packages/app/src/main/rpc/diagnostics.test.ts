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
  type RpcResult,
} from '@mongo-gui/core';
import {
  createAppServices,
  createRouter,
  type AppServices,
  type ConnectionRegistry,
  type Router,
} from './router';

// The adapter's diagnostics reads are replaced, so the router is tested without a server.
vi.mock('@mongo-gui/mongo-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mongo-gui/mongo-adapter')>();
  return {
    ...actual,
    getServerLog: vi.fn(),
    getCommandLineOptions: vi.fn(),
    getParameters: vi.fn(),
    getServerStatusTree: vi.fn(),
    killSessions: vi.fn(),
  };
});

type Client = ReturnType<ConnectionRegistry['getClient']>;

const CONNECTION_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const CLIENT = { marker: 'fake client' } as unknown as Client;
const SESSION_ID = '1f9c2a4e8b7d4c1a9e3f0a6b2d5c8e71';
const URI = 'mongodb://admin:hunter2@db.internal:27017/?authSource=admin';

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
  return {
    async connect(profile: ConnectionProfile): Promise<ConnectionStatus> {
      return { state: 'disconnected', id: profile.id } as unknown as ConnectionStatus;
    },
    async disconnect() {
      return undefined;
    },
    async disconnectAll() {
      return undefined;
    },
    status() {
      return { state: 'disconnected' } as ConnectionStatus;
    },
    getClient(connectionId: string): Client {
      if (connectionId !== CONNECTION_ID) {
        throw new AppErrorException(appError('NOT_CONNECTED', 'Connect to the server first'));
      }
      return CLIENT;
    },
    async test() {
      return { ok: true, serverVersion: '8.0.17', topology: 'standalone' } as const;
    },
    onStatusChange() {
      return () => undefined;
    },
  } as unknown as ConnectionRegistry;
}

describe('diagnostics calls through the router', () => {
  let services: AppServices;
  let router: Router;
  let dir: string;
  let events: unknown[];

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'diagnostics-router-'));
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

  it('writes log attributes as canonical EJSON and masks secret fields', async () => {
    vi.mocked(adapter.getServerLog).mockResolvedValue({
      kind: 'global',
      total: 1,
      lines: [
        {
          ts: '2026-10-10T08:00:00.000Z',
          severity: 'I',
          component: 'ACCESS',
          id: 1,
          message: `Connecting to ${URI}`,
          attributes: { port: 27017, password: 'hunter2', at: new Date(0) },
          raw: `{"msg":"Connecting to ${URI}"}`,
        },
      ],
    });

    const result = await router.handle('diagnostics.getLog', {
      connectionId: CONNECTION_ID,
      kind: 'global',
    });

    const reply = value(result) as { lines: { attributes: unknown; message: string }[] };
    expect(reply.lines[0]?.attributes).toEqual({
      port: { $numberInt: '27017' },
      password: '***',
      at: { $date: { $numberLong: '0' } },
    });
    expect(reply.lines[0]?.message).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('masks the password in the command line options', async () => {
    vi.mocked(adapter.getCommandLineOptions).mockResolvedValue({
      argv: ['mongod', '--config', URI],
      parsed: {
        net: { tls: { sslPEMKeyPassword: 'pem-secret', certificateKeyFile: '/etc/tls.pem' } },
      },
      parsedEjson: '{"net":{"tls":{"sslPEMKeyPassword":"pem-secret"}}}',
    });

    const result = await router.handle('diagnostics.cmdLineOpts', { connectionId: CONNECTION_ID });

    expect(value(result)).toEqual({
      argv: ['mongod', '--config', 'mongodb://admin:***@db.internal:27017/?authSource=admin'],
      parsed: {
        net: { tls: { sslPEMKeyPassword: '***', certificateKeyFile: '/etc/tls.pem' } },
      },
    });
    expect(JSON.stringify(result)).not.toContain('pem-secret');
  });

  it('masks secret parameters and redacts URI values', async () => {
    vi.mocked(adapter.getParameters).mockResolvedValue([
      { name: 'ldapBindPassword', value: 'hunter2', valueEjson: '"hunter2"' },
      { name: 'ldapServers', value: URI, valueEjson: JSON.stringify(URI) },
      { name: 'logLevel', value: 0, valueEjson: '{"$numberInt":"0"}' },
    ]);

    const result = await router.handle('diagnostics.parameters', { connectionId: CONNECTION_ID });

    expect(value(result)).toEqual([
      { name: 'ldapBindPassword', value: '***', valueEjson: '"***"' },
      {
        name: 'ldapServers',
        value: 'mongodb://admin:***@db.internal:27017/?authSource=admin',
        valueEjson: '"mongodb://admin:***@db.internal:27017/?authSource=admin"',
      },
      { name: 'logLevel', value: 0, valueEjson: '{"$numberInt":"0"}' },
    ]);
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('sends the server status document as canonical EJSON with secrets masked', async () => {
    vi.mocked(adapter.getServerStatusTree).mockResolvedValue({
      at: '2026-10-10T08:00:00.000Z',
      rawJson: '{}',
      canonicalJson: JSON.stringify({
        localTime: { $date: { $numberLong: '0' } },
        repl: { password: 'hunter2' },
      }),
      stripped: ['tcmalloc'],
    });

    const result = await router.handle('diagnostics.serverStatus', { connectionId: CONNECTION_ID });

    expect(value(result)).toEqual({
      at: '2026-10-10T08:00:00.000Z',
      stripped: ['tcmalloc'],
      document: {
        localTime: { $date: { $numberLong: '0' } },
        repl: { password: '***' },
      },
    });
  });

  it('kills sessions on a connected server and reports no catalog change', async () => {
    vi.mocked(adapter.killSessions).mockResolvedValue(undefined);

    const result = await router.handle('diagnostics.killSessions', {
      connectionId: CONNECTION_ID,
      ids: [SESSION_ID],
    });

    expect(value(result)).toBeUndefined();
    expect(adapter.killSessions).toHaveBeenCalledWith(CLIENT, [SESSION_ID]);
    expect(events.some((event) => (event as { type: string }).type === 'catalog:changed')).toBe(
      false,
    );
  });

  it('refuses a kill on a connection that is not connected and runs nothing', async () => {
    const otherId = '7d1e9f04-2b3c-4d5e-8f60-a1b2c3d4e5f6';

    const result = await router.handle('diagnostics.killSessions', {
      connectionId: otherId,
      ids: [SESSION_ID],
    });

    expect(failure(result).code).toBe('NOT_CONNECTED');
    expect(adapter.killSessions).not.toHaveBeenCalled();
  });

  it('refuses a session id that is not 32 hex digits before any call', async () => {
    const result = await router.handle('diagnostics.killSessions', {
      connectionId: CONNECTION_ID,
      ids: ['not-a-session'],
    });

    expect(failure(result).code).toBe('VALIDATION');
    expect(adapter.killSessions).not.toHaveBeenCalled();
  });
});
