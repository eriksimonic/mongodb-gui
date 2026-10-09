import { createServer, type Server } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppErrorException, type DockerMongoContainer } from '@mongo-gui/core';
import { FORWARDER_LABEL } from './discovery';
import {
  DEFAULT_FORWARDER_SCOPE,
  FORWARDER_IMAGE,
  FORWARDER_SCOPE_LABEL,
  createForwarderManager,
  forwarderLabelFor,
  type ForwarderManager,
} from './forwarder';
import type { ContainerCreateSpec, ContainerListItem, DockerEngineClient } from './engine-client';

interface FakeContainer {
  readonly id: string;
  readonly labels: Record<string, string>;
  state: string;
  hostPort: number;
  readonly spec: ContainerCreateSpec | undefined;
}

interface FakeEngine {
  readonly client: DockerEngineClient;
  readonly containers: Map<string, FakeContainer>;
  readonly pulled: string[];
  readonly removed: string[];
  readonly image: { present: boolean };
}

const SOCAT_IMAGE_ID = 'sha256:socat-pinned';
const TARGET_ID = 'b'.repeat(64);
const OTHER_TARGET_ID = 'c'.repeat(64);

function target(overrides: Partial<DockerMongoContainer> = {}): DockerMongoContainer {
  return {
    id: TARGET_ID,
    name: 'shop-db',
    image: 'mongo:8.0.17',
    state: 'running',
    internalPort: 27017,
    networks: ['app_net'],
    env: {},
    envKeys: [],
    ...overrides,
  };
}

/** Builds an in-memory engine. The forwarder's host port is the port of `listenPort`. */
function fakeEngine(listenPort: () => number, targetInspect: unknown = {}): FakeEngine {
  const containers = new Map<string, FakeContainer>();
  const pulled: string[] = [];
  const removed: string[] = [];
  let counter = 0;
  const image = { present: true };
  const matchesLabel = (labels: Record<string, string>, filter: string): boolean => {
    const [key, value] = filter.split('=', 2);
    if (key === undefined || labels[key] === undefined) {
      return false;
    }
    return value === undefined || labels[key] === value;
  };
  const listed = (): ContainerListItem[] =>
    [...containers.values()].map((container) => ({
      id: container.id,
      names: [],
      image: FORWARDER_IMAGE,
      imageId: SOCAT_IMAGE_ID,
      state: container.state,
      labels: container.labels,
      ports: [],
    }));
  const unexpected = (): never => {
    throw new Error('not expected');
  };
  const client: DockerEngineClient = {
    ping: unexpected,
    version: unexpected,
    listContainers: unexpected,
    async listContainersByLabel(label) {
      return listed().filter((item) => matchesLabel(item.labels, label));
    },
    async inspectContainer(id) {
      if (id === TARGET_ID) {
        return targetInspect;
      }
      const container = containers.get(id);
      if (container === undefined) {
        throw new Error(`no container ${id}`);
      }
      return {
        Id: id,
        NetworkSettings: {
          Ports: { '27017/tcp': [{ HostIp: '127.0.0.1', HostPort: String(container.hostPort) }] },
        },
      };
    },
    async createContainer(spec) {
      counter += 1;
      const id = `fwd-${counter}`;
      containers.set(id, {
        id,
        labels: { ...(spec.labels ?? {}) },
        state: 'created',
        hostPort: 0,
        spec,
      });
      return id;
    },
    async startContainer(id) {
      const container = containers.get(id);
      if (container === undefined) {
        throw new Error('missing');
      }
      container.state = 'running';
      container.hostPort = listenPort();
    },
    async removeContainer(id) {
      removed.push(id);
      containers.delete(id);
    },
    async imageId() {
      return SOCAT_IMAGE_ID;
    },
    async hasImage() {
      return image.present;
    },
    async pullImage(reference) {
      pulled.push(reference);
      image.present = true;
    },
  };
  return { client, containers, pulled, removed, image };
}

describe('ForwarderManager', () => {
  let listener: Server;
  let listenPort: number;

  beforeEach(async () => {
    listener = createServer();
    await new Promise<void>((resolve) => {
      listener.listen(0, '127.0.0.1', () => resolve());
    });
    const address = listener.address();
    listenPort = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      listener.close(() => resolve());
    });
  });

  function managerFor(engine: FakeEngine, readyTimeoutMs = 500): ForwarderManager {
    return createForwarderManager({ client: engine.client, readyTimeoutMs });
  }

  it('starts a loopback forwarder on the target network and returns the bound port', async () => {
    const engine = fakeEngine(() => listenPort);
    const handle = await managerFor(engine).ensure(target());

    expect(handle).toEqual({ hostPort: listenPort, forwarderId: 'fwd-1' });
    const spec = engine.containers.get('fwd-1')?.spec;
    expect(spec).toMatchObject({
      image: FORWARDER_IMAGE,
      cmd: ['tcp-listen:27017,fork,reuseaddr', 'tcp-connect:shop-db:27017'],
      labels: { [FORWARDER_LABEL]: TARGET_ID },
      networkMode: 'app_net',
      exposedPorts: ['27017/tcp'],
      portBindings: { '27017/tcp': [{ hostIp: '127.0.0.1', hostPort: '0' }] },
      autoRemove: false,
    });
  });

  it('pulls the socat image when it is missing', async () => {
    const engine = fakeEngine(() => listenPort);
    engine.image.present = false;

    await managerFor(engine).ensure(target());

    expect(engine.pulled).toEqual([FORWARDER_IMAGE]);
  });

  it('reuses a running forwarder for the same target', async () => {
    const engine = fakeEngine(() => listenPort);
    const manager = managerFor(engine);
    const first = await manager.ensure(target());
    const second = await manager.ensure(target());

    expect(second).toEqual(first);
    expect(engine.containers.size).toBe(1);
  });

  it('replaces a stopped forwarder for the same target', async () => {
    const engine = fakeEngine(() => listenPort);
    engine.containers.set('old', {
      id: 'old',
      labels: { [FORWARDER_LABEL]: TARGET_ID },
      state: 'exited',
      hostPort: 1,
      spec: undefined,
    });

    const handle = await managerFor(engine).ensure(target());

    expect(engine.removed).toContain('old');
    expect(handle.forwarderId).toBe('fwd-1');
  });

  it('shares one start between concurrent ensure calls for the same target', async () => {
    const engine = fakeEngine(() => listenPort);
    const manager = managerFor(engine);
    const [first, second] = await Promise.all([manager.ensure(target()), manager.ensure(target())]);

    expect(first).toEqual(second);
    expect(engine.containers.size).toBe(1);
  });

  it('dials the bridge address when the target is on the default bridge network', async () => {
    const engine = fakeEngine(() => listenPort, {
      NetworkSettings: { Networks: { bridge: { IPAddress: '172.17.0.9' } } },
    });

    await managerFor(engine).ensure(target({ networks: ['bridge'] }));

    expect(engine.containers.get('fwd-1')?.spec?.cmd?.[1]).toBe('tcp-connect:172.17.0.9:27017');
  });

  it('refuses a target on a network the forwarder cannot join', async () => {
    const engine = fakeEngine(() => listenPort);

    await expect(managerFor(engine).ensure(target({ networks: ['host'] }))).rejects.toMatchObject({
      error: { code: 'COMMAND_FAILED' },
    });
    expect(engine.containers.size).toBe(0);
  });

  it('removes the forwarder and fails when its port never accepts connections', async () => {
    const closed = await closedPort();
    const engine = fakeEngine(() => closed);

    const failure = await managerFor(engine, 200)
      .ensure(target())
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppErrorException);
    expect(failure).toMatchObject({ error: { code: 'CONNECTION_TIMEOUT' } });
    expect(engine.removed).toEqual(['fwd-1']);
    expect(engine.containers.size).toBe(0);
  });

  it('releases only the forwarder of the given target', async () => {
    const engine = fakeEngine(() => listenPort);
    const manager = managerFor(engine);
    await manager.ensure(target());
    await manager.ensure(target({ id: OTHER_TARGET_ID, name: 'other' }));

    await manager.release(TARGET_ID);

    expect(engine.removed).toEqual(['fwd-1']);
    expect(
      await engine.client.listContainersByLabel(forwarderLabelFor(OTHER_TARGET_ID)),
    ).toHaveLength(1);
  });

  it('treats a missing forwarder as released', async () => {
    const engine = fakeEngine(() => listenPort);

    await expect(managerFor(engine).release(TARGET_ID)).resolves.toBeUndefined();
  });

  it('removes a labelled forwarder whose tag moved, matched by the pinned image id', async () => {
    const engine = fakeEngine(() => listenPort);
    engine.containers.set('retagged', {
      id: 'retagged',
      labels: { [FORWARDER_LABEL]: TARGET_ID },
      state: 'exited',
      hostPort: 1,
      spec: undefined,
    });
    const original = engine.client.listContainersByLabel.bind(engine.client);
    engine.client.listContainersByLabel = async (label) =>
      (await original(label)).map((item) =>
        item.id === 'retagged' ? { ...item, image: 'alpine/socat:1.7.4.4' } : item,
      );

    await managerFor(engine).release(TARGET_ID);

    expect(engine.removed).toEqual(['retagged']);
  });

  it('does not remove a container that carries the label but is not the forwarder image', async () => {
    const engine = fakeEngine(() => listenPort);
    engine.containers.set('imposter', {
      id: 'imposter',
      labels: { [FORWARDER_LABEL]: TARGET_ID },
      state: 'running',
      hostPort: 1,
      spec: undefined,
    });
    const imposter = engine.containers.get('imposter');
    expect(imposter).toBeDefined();
    const original = engine.client.listContainersByLabel.bind(engine.client);
    engine.client.listContainersByLabel = async (label) =>
      (await original(label)).map((item) =>
        item.id === 'imposter' ? { ...item, image: 'nginx:1', imageId: 'sha256:other' } : item,
      );

    await managerFor(engine).release(TARGET_ID);

    expect(engine.removed).toEqual([]);
    expect(engine.containers.has('imposter')).toBe(true);
  });

  it('removes every labelled forwarder at cleanup and leaves other containers alone', async () => {
    const engine = fakeEngine(() => listenPort);
    engine.containers.set('stale-1', {
      id: 'stale-1',
      labels: { [FORWARDER_LABEL]: 'gone-target' },
      state: 'exited',
      hostPort: 1,
      spec: undefined,
    });
    engine.containers.set('unrelated', {
      id: 'unrelated',
      labels: { app: 'x' },
      state: 'running',
      hostPort: 1,
      spec: undefined,
    });

    await managerFor(engine).cleanupAll();

    expect(engine.removed).toEqual(['stale-1']);
    expect([...engine.containers.keys()]).toEqual(['unrelated']);
  });

  it('labels a forwarder with its scope and does not reuse another scope for the same target', async () => {
    const engine = fakeEngine(() => listenPort);
    const first = createForwarderManager({
      client: engine.client,
      readyTimeoutMs: 500,
      scope: 'run-a',
    });
    const second = createForwarderManager({
      client: engine.client,
      readyTimeoutMs: 500,
      scope: 'run-b',
    });

    await first.ensure(target());
    expect(engine.containers.get('fwd-1')?.labels).toEqual({
      [FORWARDER_LABEL]: TARGET_ID,
      [FORWARDER_SCOPE_LABEL]: 'run-a',
    });

    const handle = await second.ensure(target());

    expect(handle.forwarderId).toBe('fwd-2');
    expect(engine.containers.size).toBe(2);
  });

  it('cleans up only the forwarders of its own scope', async () => {
    const engine = fakeEngine(() => listenPort);
    addForwarder(engine, 'mine', {
      [FORWARDER_LABEL]: 'gone-target',
      [FORWARDER_SCOPE_LABEL]: 'run-a',
    });
    addForwarder(engine, 'theirs', {
      [FORWARDER_LABEL]: 'gone-target',
      [FORWARDER_SCOPE_LABEL]: 'run-b',
    });

    await createForwarderManager({ client: engine.client, scope: 'run-a' }).cleanupAll();

    expect(engine.removed).toEqual(['mine']);
    expect([...engine.containers.keys()]).toEqual(['theirs']);
  });

  it('treats a forwarder without a scope label as the default scope', async () => {
    const engine = fakeEngine(() => listenPort);
    addForwarder(engine, 'legacy', { [FORWARDER_LABEL]: 'gone-target' });
    addForwarder(engine, 'app', {
      [FORWARDER_LABEL]: 'gone-target',
      [FORWARDER_SCOPE_LABEL]: DEFAULT_FORWARDER_SCOPE,
    });
    addForwarder(engine, 'test-run', {
      [FORWARDER_LABEL]: 'gone-target',
      [FORWARDER_SCOPE_LABEL]: 'run-a',
    });

    await managerFor(engine).cleanupAll();

    expect([...engine.removed].sort()).toEqual(['app', 'legacy']);
    expect([...engine.containers.keys()]).toEqual(['test-run']);
  });

  it('removes a stale default-scope forwarder from an earlier run through a new manager', async () => {
    const engine = fakeEngine(() => listenPort);
    await managerFor(engine).ensure(target());

    await managerFor(engine).cleanupAll();

    expect(engine.removed).toEqual(['fwd-1']);
    expect(engine.containers.size).toBe(0);
  });

  it('release touches only its own scope for the same target', async () => {
    const engine = fakeEngine(() => listenPort);
    await createForwarderManager({
      client: engine.client,
      readyTimeoutMs: 500,
      scope: 'run-a',
    }).ensure(target());

    await managerFor(engine).release(TARGET_ID);

    expect(engine.removed).toEqual([]);
    expect(engine.containers.has('fwd-1')).toBe(true);
  });

  it('names the container state when the forwarder reports no host port', async () => {
    const engine = fakeEngine(() => listenPort);
    engine.client.inspectContainer = async () => ({
      State: { Status: 'exited' },
      NetworkSettings: { Ports: {} },
    });

    const failure = await managerFor(engine)
      .ensure(target())
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      error: {
        code: 'INTERNAL',
        message: 'The forwarder has no host port.',
        detail: 'state: exited',
      },
    });
    expect(engine.removed).toEqual(['fwd-1']);
  });
});

function addForwarder(engine: FakeEngine, id: string, labels: Record<string, string>): void {
  engine.containers.set(id, { id, labels, state: 'exited', hostPort: 1, spec: undefined });
}

/** A loopback port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return port;
}
