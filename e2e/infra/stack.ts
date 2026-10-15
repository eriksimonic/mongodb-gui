import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { MONGO_ROOT_PASSWORD, MONGO_ROOT_USER, type StartedMongo } from '../support/mongo';
import { seedShop } from './seed';

const execFileAsync = promisify(execFile);
const MONGO_PORT = 27017;
const DOCKER_CONTAINER_NAME = 'mongo-gui-e2e-docker';

interface ComposeStack {
  readonly project: string;
  readonly file: string;
}

const STANDALONE: ComposeStack = {
  project: 'mongo-gui-e2e-standalone',
  file: path.join(import.meta.dirname, 'standalone.yml'),
};
const REPLSET: ComposeStack = {
  project: 'mongo-gui-e2e-replset',
  file: path.join(import.meta.dirname, 'replset.yml'),
};
const DOCKER: ComposeStack = {
  project: 'mongo-gui-e2e-docker',
  file: path.join(import.meta.dirname, 'docker.yml'),
};

async function compose(stack: ComposeStack, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', [
    'compose',
    '-p',
    stack.project,
    '-f',
    stack.file,
    ...args,
  ]);
  return stdout;
}

function stopOf(stack: ComposeStack): () => Promise<void> {
  return async () => {
    // The volumes are deleted on stop, so a graceful shutdown is not needed. Kill at once.
    await compose(stack, ['down', '-v', '--remove-orphans', '-t', '0']);
  };
}

/** Starts the standalone compose stack, seeds `shop`, and returns the host URI. */
export async function startStandalone(): Promise<StartedMongo> {
  const stop = stopOf(STANDALONE);
  try {
    // --wait returns once the healthcheck passes, so the seed needs no retry loop.
    await compose(STANDALONE, ['up', '-d', '--wait']);
    const portOutput = await compose(STANDALONE, ['port', 'mongo', String(MONGO_PORT)]);
    const port = portOutput.trim().slice(portOutput.trim().lastIndexOf(':') + 1);
    const uri = `mongodb://${MONGO_ROOT_USER}:${MONGO_ROOT_PASSWORD}@127.0.0.1:${port}/?authSource=admin`;
    await seedShop(uri);
    return { uri, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * Starts the three-member replica set `rs0` on loopback ports 27031 to 27033. The first member
 * initiates the set in its healthcheck, so `up --wait` returns once a primary exists.
 */
export async function startReplicaSet(): Promise<StartedMongo> {
  const stop = stopOf(REPLSET);
  try {
    await compose(REPLSET, ['up', '-d', '--wait']);
    const uri = 'mongodb://127.0.0.1:27031,127.0.0.1:27032,127.0.0.1:27033/?replicaSet=rs0';
    await seedShop(uri);
    return { uri, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * Starts a MongoDB container with no published port. The app reaches it only through the Docker
 * socket. The seed runs before `up --wait` returns, see docker.yml.
 */
export async function startDockerDirect(): Promise<{
  readonly containerName: string;
  stop(): Promise<void>;
}> {
  const stop = stopOf(DOCKER);
  try {
    await compose(DOCKER, ['up', '-d', '--wait']);
    return { containerName: DOCKER_CONTAINER_NAME, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
