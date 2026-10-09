import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { CONTAINER_STARTUP_TIMEOUT_MS } from './mongo-container';

export const REPLICA_SET_NAME = 'rs0';
const MONGO_PORT = 27017;
const POLL_INTERVAL_MS = 500;
const CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_WAIT_MS = 60_000;

// One mongod in a container. The set knows members by the internal host, which is the network
// alias with the port. The test process reaches the same member through the published port.
export interface MongoNode {
  readonly host: string;
  readonly directUri: string;
  readonly container: StartedTestContainer;
}

export interface ReplicaSetHarness {
  readonly nodes: readonly MongoNode[];
  // Starts one more replica set member on the same network. It is not yet part of the set.
  addNode(alias: string): Promise<MongoNode>;
  // Finds the member that reports itself as writable primary, or undefined while there is none.
  findPrimary(): Promise<MongoNode | undefined>;
  stop(): Promise<void>;
}

export interface StartNodeOptions {
  readonly replSet: boolean;
  readonly network?: StartedNetwork;
  readonly alias?: string;
}

// Starts a mongod that is ready to accept connections. With replSet, the node starts as a member
// of REPLICA_SET_NAME and waits for an initiate, so it is not yet a set.
export async function startMongoNode(image: string, options: StartNodeOptions): Promise<MongoNode> {
  let container = new GenericContainer(image)
    .withExposedPorts(MONGO_PORT)
    // The official image logs this once per running server. The node has no init phase because
    // no root user is configured, so the first message means it is listening.
    .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/))
    .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS);
  if (options.replSet) {
    container = container.withCommand(['--replSet', REPLICA_SET_NAME, '--bind_ip_all']);
  }
  if (options.network !== undefined && options.alias !== undefined) {
    container = container.withNetwork(options.network).withNetworkAliases(options.alias);
  }
  const started = await container.start();
  await waitUntil(
    () => canPing(directUriOf(started)),
    CONTAINER_STARTUP_TIMEOUT_MS,
    'the node accepts connections',
  );
  return {
    host:
      options.alias === undefined ? `localhost:${MONGO_PORT}` : `${options.alias}:${MONGO_PORT}`,
    // Read on every access, so a restarted container reports its current published port.
    get directUri() {
      return directUriOf(started);
    },
    container: started,
  };
}

// Starts a three-member set. The first member initiates it, and the call returns once one member
// is primary and the others are secondaries.
export async function startReplicaSet(image: string, size: number): Promise<ReplicaSetHarness> {
  const network = await new Network().start();
  const prefix = `rs-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const aliases = Array.from({ length: size }, (_, index) => `${prefix}-${index}`);
  const nodes: MongoNode[] = [];
  try {
    nodes.push(
      ...(await Promise.all(
        aliases.map((alias) => startMongoNode(image, { replSet: true, network, alias })),
      )),
    );
    const [first] = nodes;
    if (first === undefined) {
      throw new Error('the replica set has no members');
    }
    const members = nodes.map((node, index) => ({ _id: index, host: node.host }));
    await waitUntil(
      () =>
        withClient(first.directUri, (client) =>
          client.db('admin').command({
            replSetInitiate: { _id: REPLICA_SET_NAME, members },
          }),
        ).then(
          () => true,
          () => false,
        ),
      DEFAULT_WAIT_MS,
      'the first member accepts replSetInitiate',
    );
    await waitUntil(
      async () => (await primaryAmong(nodes)) !== undefined,
      DEFAULT_WAIT_MS,
      'the set elects a primary',
    );
  } catch (error) {
    await stopAll(nodes, network);
    throw error;
  }
  return {
    nodes,
    addNode: async (alias) => {
      const node = await startMongoNode(image, {
        replSet: true,
        network,
        alias: `${prefix}-${alias}`,
      });
      nodes.push(node);
      return node;
    },
    findPrimary: () => primaryAmong(nodes),
    stop: () => stopAll(nodes, network),
  };
}

export async function connectTo(uri: string): Promise<MongoClient> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS });
  await client.connect();
  return client;
}

// Runs fn with a fresh client and closes the client afterwards.
export async function withClient<T>(
  uri: string,
  fn: (client: MongoClient) => Promise<T>,
): Promise<T> {
  const client = await connectTo(uri);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

// Polls until check resolves true. A failing check counts as not yet true, because members restart
// and elect primaries during the wait.
export async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) {
        return;
      }
    } catch {
      // Not ready yet. The next poll tries again.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}`);
}

function directUriOf(container: StartedTestContainer): string {
  return `mongodb://${container.getHost()}:${container.getMappedPort(MONGO_PORT)}/?directConnection=true`;
}

async function canPing(uri: string): Promise<boolean> {
  return withClient(uri, (client) => client.db('admin').command({ ping: 1 })).then(
    () => true,
    () => false,
  );
}

async function primaryAmong(nodes: readonly MongoNode[]): Promise<MongoNode | undefined> {
  for (const node of nodes) {
    const writable = await withClient(node.directUri, (client) =>
      client.db('admin').command({ hello: 1 }),
    ).then(
      (hello: unknown) => isWritablePrimary(hello),
      () => false,
    );
    if (writable) {
      return node;
    }
  }
  return undefined;
}

function isWritablePrimary(hello: unknown): boolean {
  return typeof hello === 'object' && hello !== null && 'isWritablePrimary' in hello
    ? hello.isWritablePrimary === true
    : false;
}

async function stopAll(nodes: readonly MongoNode[], network: StartedNetwork): Promise<void> {
  await Promise.all(nodes.map((node) => node.container.stop().catch(() => undefined)));
  await network.stop().catch(() => undefined);
}
