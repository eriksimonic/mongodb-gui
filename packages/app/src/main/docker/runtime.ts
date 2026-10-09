import {
  AppErrorException,
  appError,
  toDockerContainerSummary,
  type ConnectionProfile,
  type ConnectionStatus,
  type DockerMongoContainer,
  type DockerMongoContainerSummary,
  type DockerStatus,
  type RpcEvent,
  type Settings,
} from '@mongo-gui/core';
import {
  FORWARDER_LABEL,
  MONGO_PORT,
  dialHost,
  discoverMongoContainers,
  dockerStatus,
  type DockerEngineClient,
  type ForwarderManager,
} from '@mongo-gui/docker';
import type { ConnectionsRepository, SettingsRepository } from '@mongo-gui/storage';
import type { Logger } from '../log';

export const DOCKER_POLL_INTERVAL_MS = 10_000;
const LOOPBACK = '127.0.0.1';
const IPV6_HOST_MARKER = ':';

/** The two repositories the runtime writes profiles and settings through. */
export interface DockerRepos {
  readonly connections: ConnectionsRepository;
  readonly settings: SettingsRepository;
}

/** The part of the connection manager the runtime uses. */
export interface DockerConnections {
  connect(profile: ConnectionProfile): Promise<ConnectionStatus>;
  disconnect(connectionId: string): Promise<void>;
}

export interface DockerRuntimeDeps {
  readonly engine: DockerEngineClient;
  /** The socket the engine client talks to. Named in the status reason. */
  readonly socketPath: string;
  readonly forwarders: ForwarderManager;
  readonly connections: DockerConnections;
  /** Read at each call, because a vault reset replaces the repositories. */
  readonly repos: () => DockerRepos;
  readonly isUnlocked: () => boolean;
  readonly log: Logger;
  readonly pollIntervalMs?: number;
}

export interface DockerConnectResult {
  readonly connectionId: string;
  readonly status: ConnectionStatus;
}

/** The Docker features the router exposes. Created once per app session. */
export interface DockerRuntime {
  status(): Promise<DockerStatus>;
  list(): Promise<DockerMongoContainerSummary[]>;
  connect(containerId: string): Promise<DockerConnectResult>;
  disconnect(containerId: string): Promise<void>;
  setAutoConnect(enabled: boolean): Settings;
  /** Starts or stops the poll. Each change pushes a `docker:containers` event. */
  watch(enabled: boolean, emit: (event: RpcEvent) => void): void;
  /** Stops the poll timer while the vault is locked. The watch setting is kept. */
  suspend(): void;
  /** Starts the poll timer again after unlock, when the watch setting is on. */
  resume(): void;
  /** Connects every running container when the setting is on. Called after unlock. */
  autoConnect(): Promise<void>;
  /** Releases the forwarder of a docker profile. Other profiles are ignored. */
  releaseProfile(profile: ConnectionProfile | undefined): Promise<void>;
  /** Removes every forwarder the app labelled. Failures are logged, not thrown. */
  cleanupAll(): Promise<void>;
  /** Stops the poll and removes every forwarder. */
  dispose(): Promise<void>;
}

interface Endpoint {
  readonly host: string;
  readonly port: number;
  /** Set when the connection goes through a forwarder that the runtime must release on failure. */
  readonly forwarded: boolean;
}

interface Snapshot {
  readonly available: boolean;
  readonly containers: readonly DockerMongoContainerSummary[];
}

export function createDockerRuntime(deps: DockerRuntimeDeps): DockerRuntime {
  const pollIntervalMs = deps.pollIntervalMs ?? DOCKER_POLL_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let emitter: ((event: RpcEvent) => void) | undefined;
  let watching = false;
  let lastKey: string | undefined;
  let polling = false;

  const discover = async (): Promise<DockerMongoContainer[]> =>
    discoverMongoContainers(deps.engine);

  const findProfile = (containerId: string): ConnectionProfile | undefined =>
    deps
      .repos()
      .connections.list()
      .find((profile) => profile.dockerContainerId === containerId);

  /**
   * Resolves an id or name through the same discovery the list uses. A container that is not
   * MongoDB and a container that does not exist get the same error, so names of other containers
   * are not revealed.
   */
  async function resolveContainer(containerId: string): Promise<DockerMongoContainer> {
    const found = (await discover()).find(
      (container) => container.id === containerId || container.name === containerId,
    );
    if (found === undefined) {
      throw new AppErrorException(appError('VALIDATION', 'The container was not found.'));
    }
    return found;
  }

  async function endpointFor(container: DockerMongoContainer): Promise<Endpoint> {
    if (container.publishedPort !== undefined) {
      return {
        host: dialHost(container.publishedPort),
        port: container.publishedPort.hostPort,
        forwarded: false,
      };
    }
    // Host networking puts MongoDB on the host's own port, so no forwarder is needed.
    if (container.networks.includes('host')) {
      return { host: LOOPBACK, port: MONGO_PORT, forwarded: false };
    }
    const handle = await deps.forwarders.ensure(container);
    return { host: LOOPBACK, port: handle.hostPort, forwarded: true };
  }

  function saveProfile(container: DockerMongoContainer, uri: string): ConnectionProfile {
    const repos = deps.repos();
    const existing = findProfile(container.id);
    if (existing !== undefined) {
      return repos.connections.update(existing.id, { name: container.name, uri });
    }
    return repos.connections.create({
      name: container.name,
      uri,
      source: 'docker',
      dockerContainerId: container.id,
    });
  }

  async function connect(containerId: string): Promise<DockerConnectResult> {
    const container = await resolveContainer(containerId);
    if (container.state !== 'running') {
      throw new AppErrorException(appError('COMMAND_FAILED', 'The container is not running.'));
    }
    const endpoint = await endpointFor(container);
    try {
      const profile = saveProfile(container, buildUri(container, endpoint));
      const status = await deps.connections.connect(profile);
      if (status.state !== 'connected' && endpoint.forwarded) {
        await deps.forwarders.release(container.id);
      }
      return { connectionId: profile.id, status };
    } catch (error) {
      // A failure after the forwarder started would leave it running with no owner.
      if (endpoint.forwarded) {
        await deps.forwarders.release(container.id).catch(() => undefined);
      }
      throw error;
    }
  }

  async function tick(): Promise<void> {
    if (polling || !deps.isUnlocked()) {
      return;
    }
    polling = true;
    try {
      const snapshot = await snapshotNow();
      const key = JSON.stringify(snapshot);
      const isFirst = lastKey === undefined;
      const changed = key !== lastKey;
      lastKey = key;
      // The first snapshot after watch starts is the baseline. Only a later change is pushed.
      if (changed && !isFirst) {
        emitter?.({ type: 'docker:containers', containers: [...snapshot.containers] });
      }
    } finally {
      polling = false;
    }
  }

  async function snapshotNow(): Promise<Snapshot> {
    try {
      const containers = await discover();
      return { available: true, containers: containers.map(toDockerContainerSummary) };
    } catch {
      // An unreachable engine reads as no containers. The status call gives the reason.
      return { available: false, containers: [] };
    }
  }

  function startTimer(): void {
    if (timer !== undefined || !watching) {
      return;
    }
    lastKey = undefined;
    timer = setInterval(() => {
      void tick();
    }, pollIntervalMs);
    void tick();
  }

  function stopTimer(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    lastKey = undefined;
  }

  return {
    status() {
      return dockerStatus(deps.engine, deps.socketPath);
    },

    async list() {
      return (await discover()).map(toDockerContainerSummary);
    },

    connect,

    async disconnect(containerId) {
      const profile = findProfile(containerId);
      if (profile !== undefined) {
        await deps.connections.disconnect(profile.id);
      }
      await deps.forwarders.release(containerId);
    },

    setAutoConnect(enabled) {
      return deps.repos().settings.update({ dockerAutoConnect: enabled });
    },

    watch(enabled, emit) {
      emitter = emit;
      watching = enabled;
      if (!enabled) {
        stopTimer();
        return;
      }
      startTimer();
    },

    suspend() {
      stopTimer();
    },

    resume() {
      startTimer();
    },

    async autoConnect() {
      if (!deps.repos().settings.get().dockerAutoConnect) {
        return;
      }
      let containers: DockerMongoContainer[];
      try {
        containers = await discover();
      } catch (error) {
        deps.log.warn('docker auto connect skipped', { error: errorText(error) });
        return;
      }
      // Sequential, so forwarders start one at a time.
      for (const container of containers.filter((item) => item.state === 'running')) {
        try {
          await connect(container.id);
        } catch (error) {
          deps.log.warn('docker auto connect failed', { error: errorText(error) });
        }
      }
    },

    async releaseProfile(profile) {
      if (profile?.source === 'docker' && profile.dockerContainerId !== undefined) {
        await deps.forwarders.release(profile.dockerContainerId);
      }
    },

    cleanupAll: () => cleanupForwarders(deps.forwarders, deps.log),

    async dispose() {
      stopTimer();
      watching = false;
      await cleanupForwarders(deps.forwarders, deps.log);
    },
  };
}

async function cleanupForwarders(forwarders: ForwarderManager, log: Logger): Promise<void> {
  try {
    await forwarders.cleanupAll();
  } catch (error) {
    log.warn('docker forwarder cleanup failed', {
      label: FORWARDER_LABEL,
      error: errorText(error),
    });
  }
}

/**
 * Builds the connection URI. Credentials are percent-encoded. Root users live in admin, so
 * authSource is admin whenever credentials exist.
 */
export function buildUri(container: DockerMongoContainer, endpoint: Endpoint): string {
  const { username, password } = container.env;
  const auth =
    username === undefined || password === undefined
      ? ''
      : `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
  const host = endpoint.host.includes(IPV6_HOST_MARKER) ? `[${endpoint.host}]` : endpoint.host;
  const query = auth === '' ? 'directConnection=true' : 'directConnection=true&authSource=admin';
  return `mongodb://${auth}${host}:${endpoint.port}/?${query}`;
}

function errorText(error: unknown): string {
  return error instanceof AppErrorException ? error.error.message : 'unexpected error';
}
