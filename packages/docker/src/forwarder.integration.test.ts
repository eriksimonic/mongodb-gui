import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import type { DockerMongoContainer } from '@mongo-gui/core';
import { discoverMongoContainers } from './discovery';
import {
  createForwarderManager,
  forwarderLabelFor,
  type ForwarderHandle,
  type ForwarderManager,
} from './forwarder';
import {
  createDockerEngineClient,
  defaultDockerSocket,
  type DockerEngineClient,
} from './engine-client';

const SETUP_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 120_000;
const MONGO_IMAGE = 'mongo:8.0.17';
// Several worktrees can run this suite against one engine at once. A unique scope per run keeps
// each run's cleanup away from the forwarders of the others.
const SCOPE = `forwarder-test-${randomUUID()}`;
const OTHER_SCOPE = `forwarder-test-${randomUUID()}`;
const GONE_TIMEOUT_MS = 10_000;
const GONE_POLL_MS = 100;

// No published ports: the only route in is the forwarder on the shared network.
describe('Docker discovery and forwarder against a real engine', () => {
  let network: StartedNetwork;
  let mongo: StartedTestContainer;
  let engine: DockerEngineClient;
  let manager: ForwarderManager;
  let target: DockerMongoContainer;

  beforeAll(async () => {
    network = await new Network().start();
    mongo = await new GenericContainer(MONGO_IMAGE)
      .withNetwork(network)
      .withWaitStrategy(Wait.forLogMessage('Waiting for connections'))
      .withStartupTimeout(SETUP_TIMEOUT_MS)
      .start();
    engine = createDockerEngineClient({
      socketPath: defaultDockerSocket(process.env, process.platform),
    });
    manager = createForwarderManager({ client: engine, scope: SCOPE });
    const found = (await discoverMongoContainers(engine)).find(
      (container) => container.id === mongo.getId(),
    );
    if (found === undefined) {
      throw new Error('The test container was not discovered');
    }
    target = found;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await manager?.cleanupAll();
    await mongo?.stop();
    await network?.stop();
  }, SETUP_TIMEOUT_MS);

  it('discovers the container without a published port on its network', () => {
    expect(target.image).toBe(MONGO_IMAGE);
    expect(target.publishedPort).toBeUndefined();
    expect(target.networks).toEqual([network.getName()]);
  });

  it(
    'forwards a driver connection, then removes the forwarder on release',
    async () => {
      const handle = await manager.ensure(target);
      const mongoClient = new MongoClient(
        `mongodb://127.0.0.1:${handle.hostPort}/?directConnection=true`,
        { serverSelectionTimeoutMS: 10_000 },
      );
      try {
        await mongoClient.connect();
        const reply = await mongoClient.db('admin').command({ ping: 1 });
        expect(reply['ok']).toBe(1);
      } finally {
        await mongoClient.close();
      }

      await manager.release(target.id);

      expect(await engine.listContainersByLabel(forwarderLabelFor(target.id))).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reuses one forwarder for repeated ensure calls',
    async () => {
      const first = await manager.ensure(target);
      const second = await manager.ensure(target);

      expect(second).toEqual(first);
      expect(await engine.listContainersByLabel(forwarderLabelFor(target.id))).toHaveLength(1);
      await manager.release(target.id);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'removes stale forwarders of its own scope with cleanupAll and leaves other scopes alone',
    async () => {
      // A manager that dies without release leaves its forwarder running.
      const crashed = createForwarderManager({ client: engine, scope: SCOPE });
      const stale: ForwarderHandle = await crashed.ensure(target);

      await createForwarderManager({ client: engine, scope: OTHER_SCOPE }).cleanupAll();
      expect(await forwarderIds(engine, target.id)).toContain(stale.forwarderId);

      await createForwarderManager({ client: engine, scope: SCOPE }).cleanupAll();
      // A removal another party already started returns at once, so the container can still be
      // listed for a moment. Wait for it to finish before asserting.
      await waitUntilGone(engine, target.id, stale.forwarderId);
      expect(await forwarderIds(engine, target.id)).not.toContain(stale.forwarderId);
    },
    TEST_TIMEOUT_MS,
  );
});

async function forwarderIds(engine: DockerEngineClient, targetId: string): Promise<string[]> {
  const items = await engine.listContainersByLabel(forwarderLabelFor(targetId));
  return items.map((item) => item.id);
}

async function waitUntilGone(
  engine: DockerEngineClient,
  targetId: string,
  containerId: string,
): Promise<void> {
  const deadline = Date.now() + GONE_TIMEOUT_MS;
  while ((await forwarderIds(engine, targetId)).includes(containerId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, GONE_POLL_MS));
  }
}
