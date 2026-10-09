import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppErrorException, appError, type DockerMongoContainer } from '@mongo-gui/core';
import { FORWARDER_LABEL, MONGO_PORT, MONGO_PORT_KEY, networkAddress } from './discovery';
import type { DockerEngineClient } from './engine-client';

export const FORWARDER_IMAGE = 'alpine/socat:latest';
export const DEFAULT_READY_TIMEOUT_MS = 3_000;
const PROBE_INTERVAL_MS = 100;
const PROBE_TIMEOUT_MS = 500;
const LOOPBACK = '127.0.0.1';
const BRIDGE_NETWORK = 'bridge';
const UNREACHABLE_NETWORKS: readonly string[] = ['host', 'none'];
const NAME_SUFFIX_BYTES = 4;
const ID_PREFIX_LENGTH = 12;

const HostPortSchema = z.object({
  NetworkSettings: z.object({
    Ports: z.record(z.string(), z.array(z.object({ HostPort: z.string() })).nullish()).nullish(),
  }),
});

export interface ForwarderHandle {
  readonly hostPort: number;
  readonly forwarderId: string;
}

export interface ForwarderManagerOptions {
  readonly client: DockerEngineClient;
  /** Image that runs socat. Defaults to `alpine/socat:latest`. */
  readonly image?: string;
  /** How long a new forwarder may take to accept connections. Defaults to 3 seconds. */
  readonly readyTimeoutMs?: number;
}

export interface ForwarderManager {
  /**
   * Returns a loopback port that reaches the target's MongoDB port. A running forwarder for the
   * target is reused. Otherwise the image is pulled if missing and a new forwarder starts.
   */
  ensure(target: DockerMongoContainer): Promise<ForwarderHandle>;
  /** Removes the forwarder for one target. A missing forwarder is not an error. */
  release(targetId: string): Promise<void>;
  /** Removes every container labelled as a forwarder. Used at start and at quit. */
  cleanupAll(): Promise<void>;
}

export function forwarderLabelFor(targetId: string): string {
  return `${FORWARDER_LABEL}=${targetId}`;
}

export function createForwarderManager(options: ForwarderManagerOptions): ForwarderManager {
  const { client } = options;
  const image = options.image ?? FORWARDER_IMAGE;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  // Concurrent ensure calls for one target share a single start.
  const pending = new Map<string, Promise<ForwarderHandle>>();

  const start = async (target: DockerMongoContainer): Promise<ForwarderHandle> => {
    const network = target.networks[0];
    if (network === undefined || UNREACHABLE_NETWORKS.includes(network)) {
      throw new AppErrorException(
        appError(
          'COMMAND_FAILED',
          'The container is not on a network the app can forward through.',
        ),
      );
    }
    const address = await targetAddress(client, target.id, target.name, network);
    if (!(await client.hasImage(image))) {
      await client.pullImage(image);
    }
    const forwarderId = await client.createContainer({
      name: forwarderName(target.id),
      image,
      cmd: [`tcp-listen:${MONGO_PORT},fork,reuseaddr`, `tcp-connect:${address}:${MONGO_PORT}`],
      labels: { [FORWARDER_LABEL]: target.id },
      exposedPorts: [MONGO_PORT_KEY],
      networkMode: network,
      portBindings: { [MONGO_PORT_KEY]: [{ hostIp: LOOPBACK, hostPort: '0' }] },
      autoRemove: false,
    });
    try {
      await client.startContainer(forwarderId);
      const hostPort = hostPortOf(await client.inspectContainer(forwarderId));
      await waitForPort(hostPort, readyTimeoutMs);
      return { hostPort, forwarderId };
    } catch (error) {
      await client.removeContainer(forwarderId, true);
      throw error;
    }
  };

  return {
    ensure(target) {
      const inFlight = pending.get(target.id);
      if (inFlight !== undefined) {
        return inFlight;
      }
      const attempt = reuseOrStart(client, target, start).finally(() => {
        pending.delete(target.id);
      });
      pending.set(target.id, attempt);
      return attempt;
    },

    async release(targetId) {
      await removeAll(client, await client.listContainersByLabel(forwarderLabelFor(targetId)));
    },

    async cleanupAll() {
      await removeAll(client, await client.listContainersByLabel(FORWARDER_LABEL));
    },
  };
}

async function reuseOrStart(
  client: DockerEngineClient,
  target: DockerMongoContainer,
  start: (target: DockerMongoContainer) => Promise<ForwarderHandle>,
): Promise<ForwarderHandle> {
  const existing = await client.listContainersByLabel(forwarderLabelFor(target.id));
  const running = existing.find((item) => item.state === 'running');
  if (running !== undefined) {
    return {
      hostPort: hostPortOf(await client.inspectContainer(running.id)),
      forwarderId: running.id,
    };
  }
  await removeAll(client, existing);
  return start(target);
}

async function removeAll(
  client: DockerEngineClient,
  containers: readonly { readonly id: string }[],
): Promise<void> {
  for (const container of containers) {
    await client.removeContainer(container.id, true);
  }
}

/** The address socat dials. Named networks resolve the container name. The default bridge needs the IP. */
async function targetAddress(
  client: DockerEngineClient,
  targetId: string,
  name: string,
  network: string,
): Promise<string> {
  if (network !== BRIDGE_NETWORK) {
    return name;
  }
  const address = networkAddress(await client.inspectContainer(targetId), BRIDGE_NETWORK);
  if (address === undefined) {
    throw new AppErrorException(
      appError('COMMAND_FAILED', 'The container has no address on the default bridge network.'),
    );
  }
  return address;
}

function hostPortOf(inspectJson: unknown): number {
  const parsed = HostPortSchema.safeParse(inspectJson);
  const binding = parsed.success
    ? parsed.data.NetworkSettings.Ports?.[MONGO_PORT_KEY]?.[0]
    : undefined;
  const port = binding === undefined ? Number.NaN : Number(binding.HostPort);
  if (!Number.isInteger(port) || port <= 0) {
    throw new AppErrorException(appError('INTERNAL', 'The forwarder has no host port.'));
  }
  return port;
}

function forwarderName(targetId: string): string {
  const suffix = randomBytes(NAME_SUFFIX_BYTES).toString('hex');
  return `mongo-gui-forwarder-${targetId.slice(0, ID_PREFIX_LENGTH)}-${suffix}`;
}

/** Polls the loopback port until it accepts a TCP connection or the deadline passes. */
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
  }
  throw new AppErrorException(
    appError('CONNECTION_TIMEOUT', 'The forwarder did not accept connections in time.'),
  );
}

function probe(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: LOOPBACK, port });
    const finish = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => {
      finish(false);
    });
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(false);
    });
  });
}
