import { MongoClient } from 'mongodb';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { readBoolean, readField, readString } from '../documents';
import { CONTAINER_STARTUP_TIMEOUT_MS } from './mongo-container';

// One config server, one shard and one mongos on a private Docker network. The config server and
// the shard are named by network alias, so mongos reaches them. The host reaches each node through
// a published port with directConnection, which does not need the alias to resolve on the host.
const CONFIG_ALIAS = 'cfg';
const SHARD_ALIAS = 'shard';
const CONFIG_SET = 'cfg';
const SHARD_SET = 'sh0';
const CONFIG_PORT = 27019;
const SHARD_PORT = 27018;
const MONGOS_PORT = 27017;
const LOG_READY = /Waiting for connections/;
const PRIMARY_TIMEOUT_MS = 60_000;
const PRIMARY_POLL_MS = 250;
const ALREADY_INITIALISED_CODE = 23;

export interface StartedShardedCluster {
  // Connection string for mongos. Use it for every sharding command and for data.
  readonly mongosUri: string;
  // Connection string for the shard's own mongod, with directConnection.
  readonly shardUri: string;
  stop(): Promise<void>;
}

interface NodeSpec {
  readonly alias: string;
  readonly port: number;
  readonly command: readonly string[];
}

interface RunningNode {
  readonly container: StartedTestContainer;
  readonly uri: string;
}

export async function startShardedCluster(image: string): Promise<StartedShardedCluster> {
  const network = await new Network().start();
  const running: StartedTestContainer[] = [];
  try {
    const config = await startNode(image, network, {
      alias: CONFIG_ALIAS,
      port: CONFIG_PORT,
      command: [
        'mongod',
        '--configsvr',
        '--replSet',
        CONFIG_SET,
        '--port',
        String(CONFIG_PORT),
        '--bind_ip_all',
      ],
    });
    running.push(config.container);
    const shard = await startNode(image, network, {
      alias: SHARD_ALIAS,
      port: SHARD_PORT,
      command: [
        'mongod',
        '--shardsvr',
        '--replSet',
        SHARD_SET,
        '--port',
        String(SHARD_PORT),
        '--bind_ip_all',
      ],
    });
    running.push(shard.container);
    await initiateReplicaSet(config.uri, {
      set: CONFIG_SET,
      member: `${CONFIG_ALIAS}:${CONFIG_PORT}`,
      configsvr: true,
    });
    await initiateReplicaSet(shard.uri, { set: SHARD_SET, member: `${SHARD_ALIAS}:${SHARD_PORT}` });
    const mongos = await startMongos(
      image,
      network,
      `${CONFIG_SET}/${CONFIG_ALIAS}:${CONFIG_PORT}`,
    );
    running.push(mongos.container);
    await addShard(mongos.uri, `${SHARD_SET}/${SHARD_ALIAS}:${SHARD_PORT}`);
    return {
      mongosUri: mongos.uri,
      shardUri: shard.uri,
      stop: async () => {
        await stopAll(running, network);
      },
    };
  } catch (error) {
    await stopAll(running, network);
    throw error;
  }
}

async function startNode(
  image: string,
  network: StartedNetwork,
  spec: NodeSpec,
): Promise<RunningNode> {
  const container = await new GenericContainer(image)
    .withNetwork(network)
    .withNetworkAliases(spec.alias)
    .withCommand([...spec.command])
    .withExposedPorts(spec.port)
    .withWaitStrategy(Wait.forAll([Wait.forListeningPorts(), Wait.forLogMessage(LOG_READY)]))
    .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS)
    .start();
  return {
    container,
    uri: directUri(container, spec.port),
  };
}

async function startMongos(
  image: string,
  network: StartedNetwork,
  configDb: string,
): Promise<RunningNode> {
  const container = await new GenericContainer(image)
    .withNetwork(network)
    .withCommand(['mongos', '--configdb', configDb, '--port', String(MONGOS_PORT), '--bind_ip_all'])
    .withExposedPorts(MONGOS_PORT)
    .withWaitStrategy(Wait.forAll([Wait.forListeningPorts(), Wait.forLogMessage(LOG_READY)]))
    .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS)
    .start();
  const uri = directUri(container, MONGOS_PORT);
  await waitForRouter(uri);
  return { container, uri };
}

function directUri(container: StartedTestContainer, port: number): string {
  return `mongodb://${container.getHost()}:${container.getMappedPort(port)}/?directConnection=true`;
}

async function initiateReplicaSet(
  uri: string,
  config: { set: string; member: string; configsvr?: boolean },
): Promise<void> {
  const client = connect(uri);
  try {
    await client.connect();
    const admin = client.db('admin');
    try {
      await admin.command({
        replSetInitiate: {
          _id: config.set,
          ...(config.configsvr === true ? { configsvr: true } : {}),
          members: [{ _id: 0, host: config.member }],
        },
      });
    } catch (error) {
      if (!isAlreadyInitialised(error)) {
        throw error;
      }
    }
    await waitForPrimary(client);
  } finally {
    await client.close();
  }
}

async function addShard(mongosUri: string, shardHost: string): Promise<void> {
  const client = connect(mongosUri);
  try {
    await client.connect();
    await client.db('admin').command({ addShard: shardHost });
  } finally {
    await client.close();
  }
}

async function waitForPrimary(client: MongoClient): Promise<void> {
  const deadline = Date.now() + PRIMARY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const hello: unknown = await client.db('admin').command({ hello: 1 });
    if (readBoolean(hello, 'isWritablePrimary') === true) {
      return;
    }
    await sleep(PRIMARY_POLL_MS);
  }
  throw new Error('The replica set did not elect a primary in time');
}

async function waitForRouter(uri: string): Promise<void> {
  const client = connect(uri);
  try {
    await client.connect();
    const deadline = Date.now() + PRIMARY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const hello: unknown = await client.db('admin').command({ hello: 1 });
      if (readString(hello, 'msg') === 'isdbgrid') {
        return;
      }
      await sleep(PRIMARY_POLL_MS);
    }
    throw new Error('mongos did not answer as a router in time');
  } finally {
    await client.close();
  }
}

function connect(uri: string): MongoClient {
  return new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
}

async function stopAll(
  containers: readonly StartedTestContainer[],
  network: StartedNetwork,
): Promise<void> {
  // Stop mongos first, so the config server and the shard do not log errors for a router that
  // is still reconnecting.
  for (const container of [...containers].reverse()) {
    await container.stop();
  }
  await network.stop();
}

function isAlreadyInitialised(error: unknown): boolean {
  return readField(error, 'code') === ALREADY_INITIALISED_CODE;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
