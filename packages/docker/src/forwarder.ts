import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { generate } from 'selfsigned';
import { z } from 'zod';
import { AppErrorException, appError, type DockerMongoContainer } from '@mongo-gui/core';
import { FORWARDER_LABEL, MONGO_PORT, MONGO_PORT_KEY, networkAddress } from './discovery';
import type { ContainerListItem, DockerEngineClient } from './engine-client';

// Pinned to the newest versioned tag on Docker Hub when plan P1-7 was implemented (2026-10-09).
// The `latest` tag moves, so bump this constant on purpose, after a check that the tag still
// accepts the socat arguments used below.
export const FORWARDER_IMAGE = 'alpine/socat:1.8.1.3';
export const DEFAULT_READY_TIMEOUT_MS = 3_000;
const PROBE_INTERVAL_MS = 100;
const PROBE_TIMEOUT_MS = 500;
const LOOPBACK = '127.0.0.1';
const BRIDGE_NETWORK = 'bridge';
const UNREACHABLE_NETWORKS: readonly string[] = ['host', 'none'];
const NAME_SUFFIX_BYTES = 4;
const ID_PREFIX_LENGTH = 12;
const CERT_VALID_DAYS = 7;
const MS_PER_DAY = 86_400_000;
const CERT_DIR = '/tmp';
// The entrypoint writes the PEMs from the environment to files, then runs socat with the command.
const ENTRYPOINT_SCRIPT = [
  `printf '%s' "$FORWARDER_CERT" > ${CERT_DIR}/server.pem`,
  `printf '%s' "$FORWARDER_KEY" > ${CERT_DIR}/server.key`,
  `chmod 600 ${CERT_DIR}/server.key`,
  'exec socat "$@"',
].join('; ');

const HostPortSchema = z.object({
  NetworkSettings: z.object({
    Ports: z.record(z.string(), z.array(z.object({ HostPort: z.string() })).nullish()).nullish(),
  }),
});
const StateSchema = z.object({ State: z.object({ Status: z.string().optional() }).nullish() });

/**
 * The label that scopes forwarders to one app instance. Forwarders without it count as the
 * default scope, so forwarders from before scopes existed are still cleaned up.
 */
export const FORWARDER_SCOPE_LABEL = `${FORWARDER_LABEL}.scope`;
export const DEFAULT_FORWARDER_SCOPE = 'app';

/** The PEM material the app needs to connect. The private key never leaves memory except as a file the caller writes. */
export interface ForwarderTls {
  /** The server certificate, which also signed the client certificate. Used as the trusted CA. */
  readonly caPem: string;
  /** The client certificate followed by its private key, as `tlsCertificateKeyFile` expects. */
  readonly clientPem: string;
}

export interface ForwarderHandle {
  readonly hostPort: number;
  readonly forwarderId: string;
  readonly tls: ForwarderTls;
}

export interface ForwarderManagerOptions {
  readonly client: DockerEngineClient;
  /** Image that runs socat. Defaults to the pinned `alpine/socat:1.8.1.3` (FORWARDER_IMAGE). */
  readonly image?: string;
  /** How long a new forwarder may take to accept connections. Defaults to 3 seconds. */
  readonly readyTimeoutMs?: number;
  /**
   * Instance scope. Reuse, release and cleanup see only forwarders with this scope. The app keeps
   * the default. Tests pass a unique value so parallel runs do not touch each other's forwarders.
   */
  readonly scope?: string;
}

export interface ForwarderManager {
  /**
   * Returns a loopback port that reaches the target's MongoDB port, with the client certificate
   * the port requires. A running forwarder whose certificates this manager still holds is reused.
   * Otherwise the image is pulled if missing and a new forwarder starts with fresh certificates.
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
  const scope = options.scope ?? DEFAULT_FORWARDER_SCOPE;
  // Concurrent ensure calls for one target share a single start.
  const pending = new Map<string, Promise<ForwarderHandle>>();
  // Certificates by forwarder id. They exist only here, so a forwarder from an earlier run is replaced.
  const certificates = new Map<string, ForwarderTls>();

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
    const material = await generateCertificates();
    const forwarderId = await client.createContainer({
      name: forwarderName(target.id),
      image,
      entrypoint: ['sh', '-c', ENTRYPOINT_SCRIPT, 'sh'],
      env: [`FORWARDER_CERT=${material.serverCert}`, `FORWARDER_KEY=${material.serverKey}`],
      cmd: [
        `openssl-listen:${MONGO_PORT},fork,reuseaddr,cert=${CERT_DIR}/server.pem,key=${CERT_DIR}/server.key,cafile=${CERT_DIR}/server.pem,verify=1`,
        `tcp-connect:${address}:${MONGO_PORT}`,
      ],
      labels: { [FORWARDER_LABEL]: target.id, [FORWARDER_SCOPE_LABEL]: scope },
      exposedPorts: [MONGO_PORT_KEY],
      networkMode: network,
      portBindings: { [MONGO_PORT_KEY]: [{ hostIp: LOOPBACK, hostPort: '0' }] },
      autoRemove: false,
    });
    try {
      await client.startContainer(forwarderId);
      const hostPort = hostPortOf(await client.inspectContainer(forwarderId));
      await waitForPort(hostPort, readyTimeoutMs);
      const tls = { caPem: material.serverCert, clientPem: material.clientPem };
      certificates.set(forwarderId, tls);
      return { hostPort, forwarderId, tls };
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
      const attempt = reuseOrStart(client, target, scope, certificates, start).finally(() => {
        pending.delete(target.id);
      });
      pending.set(target.id, attempt);
      return attempt;
    },

    async release(targetId) {
      // A start still in flight would create a forwarder after this call, so wait for it first.
      await pending.get(targetId)?.catch(() => undefined);
      await removeOwned(client, await listOwned(client, scope, targetId), targetId, certificates);
    },

    async cleanupAll() {
      await removeOwned(client, await listOwned(client, scope), undefined, certificates);
    },
  };
}

/**
 * Lists the forwarders of one scope. The engine filters on the forwarder label. The scope label
 * is checked here, because the engine filter cannot match a missing label. With a target, only
 * that target's forwarders are listed.
 */
async function listOwned(
  client: DockerEngineClient,
  scope: string,
  targetId?: string,
): Promise<ContainerListItem[]> {
  const label = targetId === undefined ? FORWARDER_LABEL : forwarderLabelFor(targetId);
  const listed = await client.listContainersByLabel(label);
  return listed.filter((item) => inScope(item, scope));
}

/** A forwarder without the scope label belongs to the default scope. */
function inScope(container: ContainerListItem, scope: string): boolean {
  const owner = container.labels[FORWARDER_SCOPE_LABEL] ?? DEFAULT_FORWARDER_SCOPE;
  return owner === scope;
}

async function reuseOrStart(
  client: DockerEngineClient,
  target: DockerMongoContainer,
  scope: string,
  certificates: Map<string, ForwarderTls>,
  start: (target: DockerMongoContainer) => Promise<ForwarderHandle>,
): Promise<ForwarderHandle> {
  const existing = await listOwned(client, scope, target.id);
  const pinned = await client.imageId(FORWARDER_IMAGE);
  // Without the certificates in memory the forwarder cannot be used, so it is replaced.
  const running = existing.find(
    (item) =>
      item.state === 'running' &&
      isOwnedForwarder(item, target.id, pinned) &&
      certificates.has(item.id),
  );
  const tls = running === undefined ? undefined : certificates.get(running.id);
  if (running !== undefined && tls !== undefined) {
    return {
      hostPort: hostPortOf(await client.inspectContainer(running.id)),
      forwarderId: running.id,
      tls,
    };
  }
  await removeOwned(client, existing, target.id, certificates);
  return start(target);
}

/**
 * A container is removed only when it is a forwarder this app made. The label alone is not
 * enough, because a user container could carry the same label. The image must match too: either
 * the reference the app pulls, or the image id that reference currently resolves to. The id still
 * matches after the tag moves or is removed locally, as long as the image itself is present.
 */
function isOwnedForwarder(
  container: ContainerListItem,
  targetId: string | undefined,
  pinnedImageId: string | undefined,
): boolean {
  const sameImage =
    container.image === FORWARDER_IMAGE ||
    (pinnedImageId !== undefined && container.imageId === pinnedImageId);
  if (!sameImage) {
    return false;
  }
  const owner = container.labels[FORWARDER_LABEL];
  if (owner === undefined) {
    return false;
  }
  return targetId === undefined || owner === targetId;
}

async function removeOwned(
  client: DockerEngineClient,
  containers: readonly ContainerListItem[],
  targetId: string | undefined,
  certificates: Map<string, ForwarderTls>,
): Promise<void> {
  const pinned = await client.imageId(FORWARDER_IMAGE);
  for (const container of containers) {
    if (isOwnedForwarder(container, targetId, pinned)) {
      await client.removeContainer(container.id, true);
      certificates.delete(container.id);
    }
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

interface CertificateMaterial {
  readonly serverCert: string;
  readonly serverKey: string;
  readonly clientPem: string;
}

/**
 * Makes a fresh server certificate for 127.0.0.1 and a client certificate signed by it. Both are
 * short lived and used for one forwarder only.
 */
async function generateCertificates(): Promise<CertificateMaterial> {
  const now = Date.now();
  const generated = await generate([{ name: 'commonName', value: 'mongo-gui-forwarder' }], {
    keyType: 'ec',
    algorithm: 'sha256',
    notBeforeDate: new Date(now - MS_PER_DAY),
    notAfterDate: new Date(now + CERT_VALID_DAYS * MS_PER_DAY),
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, digitalSignature: true },
      { name: 'subjectAltName', altNames: [{ type: 7, ip: LOOPBACK }] },
    ],
    clientCertificate: {
      cn: 'mongo-gui',
      algorithm: 'sha256',
      notBeforeDate: new Date(now - MS_PER_DAY),
      notAfterDate: new Date(now + CERT_VALID_DAYS * MS_PER_DAY),
    },
  });
  if (generated.clientcert === undefined || generated.clientprivate === undefined) {
    throw new AppErrorException(appError('INTERNAL', 'The forwarder certificates were not made.'));
  }
  return {
    serverCert: generated.cert,
    serverKey: generated.private,
    clientPem: `${generated.clientcert}\n${generated.clientprivate}`,
  };
}

function hostPortOf(inspectJson: unknown): number {
  const parsed = HostPortSchema.safeParse(inspectJson);
  const binding = parsed.success
    ? parsed.data.NetworkSettings.Ports?.[MONGO_PORT_KEY]?.[0]
    : undefined;
  const port = binding === undefined ? Number.NaN : Number(binding.HostPort);
  if (!Number.isInteger(port) || port <= 0) {
    throw new AppErrorException(
      appError('INTERNAL', 'The forwarder has no host port.', `state: ${stateOf(inspectJson)}`),
    );
  }
  return port;
}

function stateOf(inspectJson: unknown): string {
  const parsed = StateSchema.safeParse(inspectJson);
  if (!parsed.success) {
    return 'unreadable inspect';
  }
  return parsed.data.State?.Status ?? 'unknown';
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
