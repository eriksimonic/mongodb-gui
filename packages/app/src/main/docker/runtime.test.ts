import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AppErrorException,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type ConnectionStatus,
  type ConnectionTestResult,
  type RpcEvent,
} from '@mongo-gui/core';
import {
  DockerEngineError,
  type DockerEngineClient,
  type ForwarderManager,
} from '@mongo-gui/docker';
import { EncryptedStore, Vault } from '@mongo-gui/storage';
import { createRepos } from '../rpc/router';
import type { Logger } from '../log';
import {
  buildUri,
  createDockerRuntime,
  type DockerConnectedResult,
  type DockerConnectResult,
  type DockerConnections,
  type DockerRuntime,
} from './runtime';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';
const CONNECTED: ConnectionStatus = {
  state: 'connected',
  serverVersion: '8.0.17',
  topology: 'standalone',
  hosts: ['127.0.0.1:40123'],
};
const SILENT_LOG: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const UNUSED = (): never => {
  throw new Error('not expected in this test');
};

/** Narrows a connect result to the connected variant. Any other result fails the test. */
function connectedOf(result: DockerConnectResult): DockerConnectedResult {
  if ('kind' in result) {
    throw new Error(`expected a connected result, got ${result.kind}`);
  }
  return result;
}

interface InspectOptions {
  readonly id: string;
  readonly name?: string;
  readonly image?: string;
  readonly status?: string;
  readonly env?: readonly string[];
  readonly published?: boolean;
  readonly networks?: readonly string[];
}

/** A minimal `docker inspect` document with the fields the runtime reads. */
function inspectOf(options: InspectOptions): Record<string, unknown> {
  const networks = options.networks ?? ['app_net'];
  return {
    Id: options.id,
    Name: `/${options.name ?? 'shop-db'}`,
    Config: {
      Image: options.image ?? 'mongo:7',
      Env: options.env ?? [],
      ExposedPorts: { '27017/tcp': {} },
    },
    State: { Status: options.status ?? 'running' },
    NetworkSettings: {
      Ports:
        options.published === true
          ? { '27017/tcp': [{ HostIp: '0.0.0.0', HostPort: '27017' }] }
          : { '27017/tcp': null },
      Networks: Object.fromEntries(networks.map((name) => [name, { IPAddress: '172.18.0.5' }])),
    },
  };
}

interface FakeEngine {
  readonly client: DockerEngineClient;
  readonly inspects: Map<string, Record<string, unknown>>;
  unreachable: boolean;
}

function fakeEngine(containers: Record<string, Record<string, unknown>>): FakeEngine {
  const inspects = new Map(Object.entries(containers));
  const engine: FakeEngine = {
    inspects,
    unreachable: false,
    client: {
      ping: UNUSED,
      version: async () => {
        if (engine.unreachable) {
          throw new DockerEngineError('Docker is not reachable.', 'ENOENT');
        }
        return { version: '29.8.2', apiVersion: '1.54' };
      },
      listContainers: async () => {
        if (engine.unreachable) {
          throw new DockerEngineError('Docker is not reachable.', 'ENOENT');
        }
        return [...inspects.values()].map((json) => {
          const config = json['Config'] as { Image: string };
          const state = json['State'] as { Status: string };
          return {
            id: String(json['Id']),
            names: [String(json['Name'])],
            image: config.Image,
            state: state.Status,
            imageId: '',
            labels: {},
            ports: [27017],
          };
        });
      },
      listContainersByLabel: async () => [],
      inspectContainer: async (id) => {
        const json = inspects.get(id);
        if (json === undefined) {
          throw new DockerEngineError('Docker returned HTTP 404.', undefined, 404);
        }
        return json;
      },
      createContainer: UNUSED,
      startContainer: UNUSED,
      removeContainer: UNUSED,
      hasImage: UNUSED,
      imageId: UNUSED,
      pullImage: UNUSED,
    },
  };
  return engine;
}

interface FakeForwarders extends ForwarderManager {
  readonly ensured: string[];
  readonly released: string[];
  cleanups: number;
}

function fakeForwarders(hostPort = 40123): FakeForwarders {
  const forwarders: FakeForwarders = {
    ensured: [],
    released: [],
    cleanups: 0,
    async ensure(target) {
      forwarders.ensured.push(target.id);
      return { hostPort, forwarderId: `fwd-${target.id}` };
    },
    async release(targetId) {
      forwarders.released.push(targetId);
    },
    async cleanupAll() {
      forwarders.cleanups += 1;
    },
  };
  return forwarders;
}

interface FakeConnections extends DockerConnections {
  readonly connected: string[];
  readonly disconnected: string[];
  readonly tested: string[];
  nextStatus: ConnectionStatus;
  nextTest: ConnectionTestResult;
  failure: Error | undefined;
}

function fakeConnections(): FakeConnections {
  const connections: FakeConnections = {
    connected: [],
    disconnected: [],
    tested: [],
    nextStatus: CONNECTED,
    nextTest: { ok: true, serverVersion: '8.0.17', topology: 'standalone' },
    failure: undefined,
    async connect(profile: ConnectionProfile) {
      connections.connected.push(profile.uri);
      if (connections.failure !== undefined) {
        throw connections.failure;
      }
      return connections.nextStatus;
    },
    async disconnect(connectionId: string) {
      connections.disconnected.push(connectionId);
    },
    async test(profile: ConnectionProfileInput) {
      connections.tested.push(profile.uri);
      return connections.nextTest;
    },
  };
  return connections;
}

interface Harness {
  readonly runtime: DockerRuntime;
  readonly engine: FakeEngine;
  readonly forwarders: FakeForwarders;
  readonly connections: FakeConnections;
  readonly repos: ReturnType<typeof createRepos>;
  readonly events: RpcEvent[];
  readonly store: EncryptedStore;
  readonly dir: string;
}

const harnesses: Harness[] = [];

function buildHarness(
  containers: Record<string, Record<string, unknown>>,
  pollIntervalMs = 60_000,
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'docker-runtime-'));
  const vault = new Vault({ dir, kdf: FAST_KDF, failureDelayMs: 0, onLocked: () => undefined });
  const store = new EncryptedStore({ path: join(dir, 'store.sqlite'), vault });
  const repos = createRepos(store);
  vault.initialise(PASSWORD);
  const engine = fakeEngine(containers);
  const forwarders = fakeForwarders();
  const connections = fakeConnections();
  const runtime = createDockerRuntime({
    engine: engine.client,
    socketPath: SOCKET,
    forwarders,
    connections,
    repos: () => repos,
    isUnlocked: () => vault.status().state === 'unlocked',
    log: SILENT_LOG,
    pollIntervalMs,
  });
  const events: RpcEvent[] = [];
  const harness: Harness = { runtime, engine, forwarders, connections, repos, events, store, dir };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.runtime.dispose();
    harness.store.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

const SOCKET = '/var/run/docker.sock';
const PUBLISHED_ID = 'a'.repeat(64);
const PLAIN_ID = 'b'.repeat(64);

describe('buildUri', () => {
  const base = {
    id: PLAIN_ID,
    name: 'db',
    image: 'mongo:7',
    state: 'running' as const,
    internalPort: 27017,
    networks: ['app_net'],
    envKeys: [],
  };

  it('encodes credentials and sets authSource to admin', () => {
    const uri = buildUri(
      { ...base, env: { username: 'ro@ot', password: 'p@ss/word' } },
      { host: '127.0.0.1', port: 40123, forwarded: true },
    );

    expect(uri).toBe(
      'mongodb://ro%40ot:p%40ss%2Fword@127.0.0.1:40123/?directConnection=true&authSource=admin',
    );
  });

  it('omits the credentials when the container has no username and password pair', () => {
    expect(
      buildUri(
        { ...base, env: { username: 'root' } },
        { host: '127.0.0.1', port: 27017, forwarded: false },
      ),
    ).toBe('mongodb://127.0.0.1:27017/?directConnection=true');
  });

  it('brackets an IPv6 host', () => {
    expect(buildUri({ ...base, env: {} }, { host: '::1', port: 27017, forwarded: false })).toBe(
      'mongodb://[::1]:27017/?directConnection=true',
    );
  });
});

describe('createDockerRuntime connect', () => {
  it('connects a published container directly and saves a docker profile', async () => {
    const harness = buildHarness({
      [PUBLISHED_ID]: inspectOf({
        id: PUBLISHED_ID,
        name: 'shop-mongo',
        published: true,
        env: ['MONGO_INITDB_ROOT_USERNAME=app', 'MONGO_INITDB_ROOT_PASSWORD=hunter2'],
      }),
    });

    const result = connectedOf(await harness.runtime.connect(PUBLISHED_ID));

    expect(result.status).toEqual(CONNECTED);
    expect(harness.forwarders.ensured).toEqual([]);
    const [profile] = harness.repos.connections.list();
    expect(profile).toMatchObject({
      id: result.connectionId,
      name: 'shop-mongo',
      source: 'docker',
      dockerContainerId: PUBLISHED_ID,
    });
    expect(profile?.uri).toBe(
      'mongodb://app:hunter2@127.0.0.1:27017/?directConnection=true&authSource=admin',
    );
  });

  it('connects an unpublished container through a forwarder and reuses its profile', async () => {
    const harness = buildHarness({
      [PLAIN_ID]: inspectOf({ id: PLAIN_ID, name: 'orders-mongo', image: 'mongo:8.0.17' }),
    });

    const first = connectedOf(await harness.runtime.connect(PLAIN_ID));
    const second = connectedOf(await harness.runtime.connect(PLAIN_ID));

    expect(harness.forwarders.ensured).toEqual([PLAIN_ID, PLAIN_ID]);
    expect(second.connectionId).toBe(first.connectionId);
    const profiles = harness.repos.connections.list();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.uri).toBe('mongodb://127.0.0.1:40123/?directConnection=true');
  });

  it('releases the forwarder when the connection does not come up', async () => {
    const harness = buildHarness({
      [PLAIN_ID]: inspectOf({ id: PLAIN_ID, name: 'orders-mongo' }),
    });
    harness.connections.nextStatus = {
      state: 'error',
      error: { code: 'CONNECTION_FAILED', message: 'Could not connect to the server' },
    };

    const result = await harness.runtime.connect(PLAIN_ID);

    expect(result).toMatchObject({ status: { state: 'error' } });
    expect(harness.forwarders.released).toEqual([PLAIN_ID]);
  });

  it('refuses a container that is not running', async () => {
    const harness = buildHarness({
      [PLAIN_ID]: inspectOf({ id: PLAIN_ID, status: 'exited' }),
    });

    await expect(harness.runtime.connect(PLAIN_ID)).rejects.toMatchObject({
      error: { code: 'COMMAND_FAILED' },
    });
    expect(harness.forwarders.ensured).toEqual([]);
  });

  it('refuses a container that is not MongoDB', async () => {
    const harness = buildHarness({
      [PLAIN_ID]: {
        ...inspectOf({ id: PLAIN_ID }),
        Config: { Image: 'nginx:1', Env: [], ExposedPorts: {} },
        NetworkSettings: { Ports: {}, Networks: {} },
      },
    });

    await expect(harness.runtime.connect(PLAIN_ID)).rejects.toMatchObject({
      error: { code: 'VALIDATION' },
    });
  });

  it('reports a missing container as a validation error', async () => {
    const harness = buildHarness({});

    const failure = await harness.runtime.connect(PLAIN_ID).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppErrorException);
    expect(failure).toMatchObject({
      error: { code: 'VALIDATION', message: 'The container was not found.' },
    });
  });
});

describe('createDockerRuntime credentials required', () => {
  const AUTH_FAILED: ConnectionStatus = {
    state: 'error',
    error: { code: 'AUTH_FAILED', message: 'Authentication failed' },
  };
  const UNAUTHORIZED: ConnectionStatus = {
    state: 'error',
    error: {
      code: 'COMMAND_FAILED',
      message: 'The server rejected the command',
      codeName: 'Unauthorized',
    },
  };

  it('asks for credentials when the server rejects a container without credentials', async () => {
    const harness = buildHarness({
      [PLAIN_ID]: inspectOf({ id: PLAIN_ID, name: 'secure-mongo' }),
    });
    harness.connections.nextStatus = AUTH_FAILED;

    const result = await harness.runtime.connect(PLAIN_ID);

    expect(result).toEqual({
      kind: 'credentialsRequired',
      containerId: PLAIN_ID,
      host: '127.0.0.1',
      port: 40123,
      hint: 'noEnv',
    });
    expect(harness.forwarders.released).toEqual([PLAIN_ID]);
  });

  it('reports envFound when the container credentials are rejected', async () => {
    const harness = buildHarness({
      [PUBLISHED_ID]: inspectOf({
        id: PUBLISHED_ID,
        name: 'shop-mongo',
        published: true,
        env: ['MONGO_INITDB_ROOT_USERNAME=app', 'MONGO_INITDB_ROOT_PASSWORD=old'],
      }),
    });
    harness.connections.nextStatus = AUTH_FAILED;

    const result = await harness.runtime.connect(PUBLISHED_ID);

    expect(result).toMatchObject({ kind: 'credentialsRequired', port: 27017, hint: 'envFound' });
  });

  it('asks for credentials on Unauthorized when no credentials were sent', async () => {
    const harness = buildHarness({
      [PLAIN_ID]: inspectOf({ id: PLAIN_ID, name: 'secure-mongo' }),
    });
    harness.connections.nextStatus = UNAUTHORIZED;

    const result = await harness.runtime.connect(PLAIN_ID);

    expect(result).toMatchObject({ kind: 'credentialsRequired', hint: 'noEnv' });
  });

  it('keeps the status when Unauthorized follows container credentials', async () => {
    const harness = buildHarness({
      [PUBLISHED_ID]: inspectOf({
        id: PUBLISHED_ID,
        published: true,
        env: ['MONGO_INITDB_ROOT_USERNAME=app', 'MONGO_INITDB_ROOT_PASSWORD=hunter2'],
      }),
    });
    harness.connections.nextStatus = UNAUTHORIZED;

    const result = await harness.runtime.connect(PUBLISHED_ID);

    expect(result).toEqual({ connectionId: expect.any(String), status: UNAUTHORIZED });
  });
});

describe('createDockerRuntime connectWithCredentials', () => {
  it('tests the typed credentials, then saves the profile and connects it', async () => {
    const harness = buildHarness({
      [PUBLISHED_ID]: inspectOf({ id: PUBLISHED_ID, name: 'secure-mongo', published: true }),
    });

    const result = await harness.runtime.connectWithCredentials({
      containerId: PUBLISHED_ID,
      username: 'ops@team',
      password: 'p@ss/word',
      authSource: 'admin',
    });

    const uri =
      'mongodb://ops%40team:p%40ss%2Fword@127.0.0.1:27017/?directConnection=true&authSource=admin';
    expect(harness.connections.tested).toEqual([uri]);
    expect(harness.connections.connected).toEqual([uri]);
    expect(result.status).toEqual(CONNECTED);
    const [profile] = harness.repos.connections.list();
    expect(profile).toMatchObject({
      id: result.connectionId,
      name: 'secure-mongo',
      source: 'docker',
      dockerContainerId: PUBLISHED_ID,
      uri,
    });
  });

  it('updates the existing docker profile instead of creating a second one', async () => {
    const harness = buildHarness({
      [PLAIN_ID]: inspectOf({ id: PLAIN_ID, name: 'secure-mongo' }),
    });
    harness.connections.nextStatus = {
      state: 'error',
      error: { code: 'AUTH_FAILED', message: 'Authentication failed' },
    };
    await harness.runtime.connect(PLAIN_ID);
    harness.connections.nextStatus = CONNECTED;

    const result = await harness.runtime.connectWithCredentials({
      containerId: PLAIN_ID,
      username: 'admin',
      password: 'admin',
      authSource: 'admin',
    });

    const profiles = harness.repos.connections.list();
    expect(profiles).toHaveLength(1);
    expect(result.connectionId).toBe(profiles[0]?.id);
    expect(profiles[0]?.uri).toBe(
      'mongodb://admin:admin@127.0.0.1:40123/?directConnection=true&authSource=admin',
    );
  });

  it('throws the test error and saves nothing when the password is wrong', async () => {
    const harness = buildHarness({
      [PLAIN_ID]: inspectOf({ id: PLAIN_ID, name: 'secure-mongo' }),
    });
    harness.connections.nextTest = {
      ok: false,
      error: { code: 'AUTH_FAILED', message: 'Authentication failed' },
    };

    const failure = await harness.runtime
      .connectWithCredentials({
        containerId: PLAIN_ID,
        username: 'admin',
        password: 'wrong',
        authSource: 'admin',
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppErrorException);
    expect(failure).toMatchObject({ error: { code: 'AUTH_FAILED' } });
    expect(harness.connections.connected).toEqual([]);
    expect(harness.repos.connections.list()).toEqual([]);
    expect(harness.forwarders.released).toEqual([PLAIN_ID]);
  });

  it('refuses a container that is not running', async () => {
    const harness = buildHarness({
      [PLAIN_ID]: inspectOf({ id: PLAIN_ID, status: 'exited' }),
    });

    await expect(
      harness.runtime.connectWithCredentials({
        containerId: PLAIN_ID,
        username: 'admin',
        password: 'admin',
        authSource: 'admin',
      }),
    ).rejects.toMatchObject({ error: { code: 'COMMAND_FAILED' } });
    expect(harness.connections.tested).toEqual([]);
  });
});

describe('createDockerRuntime failure after the forwarder starts', () => {
  it('releases the forwarder when the connection manager throws', async () => {
    const harness = buildHarness({
      [PLAIN_ID]: inspectOf({ id: PLAIN_ID, name: 'orders-mongo' }),
    });
    harness.connections.failure = new Error('driver crashed');

    await expect(harness.runtime.connect(PLAIN_ID)).rejects.toThrow('driver crashed');
    expect(harness.forwarders.released).toEqual([PLAIN_ID]);
  });
});

describe('createDockerRuntime suspend and resume', () => {
  it('pushes no events while suspended and resumes when asked', async () => {
    const harness = buildHarness({}, 20);
    harness.runtime.watch(true, (event) => {
      harness.events.push(event);
    });
    harness.runtime.suspend();
    harness.engine.inspects.set(
      PUBLISHED_ID,
      inspectOf({ id: PUBLISHED_ID, name: 'late', published: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(harness.events).toEqual([]);

    harness.runtime.resume();
    await vi.waitFor(() => expect(harness.events).toHaveLength(0));
    harness.runtime.watch(false, () => undefined);
  });
});

describe('createDockerRuntime disconnect, status and list', () => {
  it('disconnects the profile and releases its forwarder', async () => {
    const harness = buildHarness({
      [PLAIN_ID]: inspectOf({ id: PLAIN_ID, name: 'orders-mongo' }),
    });
    const { connectionId } = connectedOf(await harness.runtime.connect(PLAIN_ID));

    await harness.runtime.disconnect(PLAIN_ID);

    expect(harness.connections.disconnected).toEqual([connectionId]);
    expect(harness.forwarders.released).toEqual([PLAIN_ID]);
  });

  it('reports the engine as unavailable with the reason', async () => {
    const harness = buildHarness({});
    harness.engine.unreachable = true;

    expect(await harness.runtime.status()).toEqual({
      available: false,
      reason: 'Docker is not reachable at /var/run/docker.sock (ENOENT).',
    });
  });

  it('lists containers without their passwords', async () => {
    const harness = buildHarness({
      [PUBLISHED_ID]: inspectOf({
        id: PUBLISHED_ID,
        published: true,
        env: ['MONGO_INITDB_ROOT_USERNAME=app', 'MONGO_INITDB_ROOT_PASSWORD=hunter2'],
      }),
    });

    const [summary] = await harness.runtime.list();

    expect(summary).toMatchObject({ hasCredentials: true, env: { username: 'app' } });
    expect(JSON.stringify(summary)).not.toContain('hunter2');
  });
});

describe('createDockerRuntime auto connect and setting', () => {
  it('stores the setting and returns the updated settings', () => {
    const harness = buildHarness({});

    expect(harness.runtime.setAutoConnect(true).dockerAutoConnect).toBe(true);
    expect(harness.repos.settings.get().dockerAutoConnect).toBe(true);
  });

  it('connects only running containers when the setting is on', async () => {
    const harness = buildHarness({
      [PUBLISHED_ID]: inspectOf({ id: PUBLISHED_ID, name: 'up', published: true }),
      [PLAIN_ID]: inspectOf({ id: PLAIN_ID, name: 'down', status: 'exited' }),
    });
    harness.runtime.setAutoConnect(true);

    await harness.runtime.autoConnect();

    expect(harness.connections.connected).toEqual([
      'mongodb://127.0.0.1:27017/?directConnection=true',
    ]);
  });

  it('does nothing when the setting is off', async () => {
    const harness = buildHarness({
      [PUBLISHED_ID]: inspectOf({ id: PUBLISHED_ID, published: true }),
    });

    await harness.runtime.autoConnect();

    expect(harness.connections.connected).toEqual([]);
  });
});

describe('createDockerRuntime releaseProfile and cleanup', () => {
  it('releases the forwarder of a docker profile and ignores manual ones', async () => {
    const harness = buildHarness({});
    const manual: ConnectionProfile = {
      id: 'c4c3a0b2-0000-4000-8000-000000000001',
      name: 'Local',
      uri: 'mongodb://localhost:27017/',
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:00:00.000Z',
    };
    const docker: ConnectionProfile = { ...manual, source: 'docker', dockerContainerId: PLAIN_ID };

    await harness.runtime.releaseProfile(manual);
    await harness.runtime.releaseProfile(docker);
    await harness.runtime.releaseProfile(undefined);

    expect(harness.forwarders.released).toEqual([PLAIN_ID]);
  });

  it('removes forwarders at cleanup and tolerates a failure', async () => {
    const harness = buildHarness({});
    const failing = createDockerRuntime({
      engine: harness.engine.client,
      socketPath: SOCKET,
      forwarders: {
        ensure: UNUSED,
        release: async () => undefined,
        cleanupAll: async () => {
          throw new Error('daemon gone');
        },
      },
      connections: harness.connections,
      repos: () => harness.repos,
      isUnlocked: () => true,
      log: SILENT_LOG,
    });

    await expect(failing.cleanupAll()).resolves.toBeUndefined();
    await harness.runtime.cleanupAll();
    expect(harness.forwarders.cleanups).toBe(1);
  });
});

describe('createDockerRuntime watch', () => {
  it('pushes an event only when the container list changes', async () => {
    vi.useRealTimers();
    const harness = buildHarness({}, 20);
    const emit = (event: RpcEvent): void => {
      harness.events.push(event);
    };

    harness.runtime.watch(true, emit);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(harness.events).toEqual([]);

    harness.engine.inspects.set(
      PUBLISHED_ID,
      inspectOf({ id: PUBLISHED_ID, name: 'new', published: true }),
    );
    await vi.waitFor(() => expect(harness.events).toHaveLength(1));
    expect(harness.events[0]).toMatchObject({
      type: 'docker:containers',
      containers: [{ name: 'new' }],
    });

    harness.runtime.watch(false, emit);
  });

  it('pushes an empty list when the engine becomes unreachable', async () => {
    const harness = buildHarness(
      { [PUBLISHED_ID]: inspectOf({ id: PUBLISHED_ID, published: true }) },
      20,
    );
    harness.runtime.watch(true, (event) => {
      harness.events.push(event);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    harness.engine.unreachable = true;
    await vi.waitFor(() =>
      expect(harness.events).toEqual([{ type: 'docker:containers', containers: [] }]),
    );
    harness.runtime.watch(false, () => undefined);
  });
});
