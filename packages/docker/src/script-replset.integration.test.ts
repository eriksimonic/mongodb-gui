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
import { MONGO_PORT, discoverMongoContainers } from './discovery';
import { createForwarderManager, type ForwarderManager } from './forwarder';
import {
  createDockerEngineClient,
  defaultDockerSocket,
  type DockerEngineClient,
} from './engine-client';

const SETUP_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 120_000;
const MONGO_IMAGE = 'mongo:8.0.17';
const SCOPE = `script-replset-test-${randomUUID()}`;
// Resolves only inside the test network, like a compose service name.
const MEMBER_HOST = 'mongo1';
const REPLICA_SET = 'rs0';
// A compose-style start script: PID 1 is bash, and mongod is its child.
const START_SCRIPT = `mongod --replSet ${REPLICA_SET} --port ${MONGO_PORT} --bind_ip 0.0.0.0 & wait $!`;
const INITIATE = `rs.initiate({ _id: '${REPLICA_SET}', members: [{ _id: 0, host: '${MEMBER_HOST}:${MONGO_PORT}' }] })`;
const PRIMARY_TIMEOUT_MS = 60_000;
const PRIMARY_POLL_MS = 500;

async function waitForPrimary(container: StartedTestContainer): Promise<void> {
  const deadline = Date.now() + PRIMARY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { output } = await container.exec([
      'mongosh',
      '--quiet',
      '--eval',
      'db.hello().isWritablePrimary',
    ]);
    if (output.trim() === 'true') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, PRIMARY_POLL_MS));
  }
  throw new Error('The replica set did not elect a primary');
}

// The flowbase compose setup: a replica set whose member host the machine cannot resolve, no
// published port, and mongod started by a script. Discovery has to find mongod as a child
// process, and the client has to stay on the forwarder instead of following the member host.
describe('Docker replica set started by a script, without a published port', () => {
  let network: StartedNetwork;
  let mongo: StartedTestContainer;
  let engine: DockerEngineClient;
  let manager: ForwarderManager;
  let target: DockerMongoContainer;

  beforeAll(async () => {
    network = await new Network().start();
    mongo = await new GenericContainer(MONGO_IMAGE)
      .withNetwork(network)
      .withNetworkAliases(MEMBER_HOST)
      .withEntrypoint(['/bin/bash', '-c'])
      .withCommand([START_SCRIPT])
      .withWaitStrategy(Wait.forLogMessage('Waiting for connections'))
      .withStartupTimeout(SETUP_TIMEOUT_MS)
      .start();
    await mongo.exec(['mongosh', '--quiet', '--eval', INITIATE]);
    await waitForPrimary(mongo);
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

  it('finds mongod under the start script and reads its port', () => {
    expect(target.internalPort).toBe(MONGO_PORT);
    expect(target.publishedPort).toBeUndefined();
  });

  it(
    'connects to the replica set member through the forwarder',
    async () => {
      const handle = await manager.ensure(target);
      const client = new MongoClient(
        `mongodb://127.0.0.1:${handle.hostPort}/?directConnection=true`,
        {
          serverSelectionTimeoutMS: 10_000,
          tls: true,
          ca: handle.tls.caPem,
          cert: handle.tls.clientPem,
          key: handle.tls.clientPem,
        },
      );
      try {
        const hello = await client.db('admin').command({ hello: 1 });

        expect(hello['setName']).toBe(REPLICA_SET);
        expect(hello['isWritablePrimary']).toBe(true);
      } finally {
        await client.close();
        await manager.release(target.id);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
