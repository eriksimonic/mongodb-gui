import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import {
  AppErrorException,
  appError,
  toDockerContainerSummary,
  type AppError,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type ConnectionStatus,
  type ConnectionTestResult,
  type DockerConnectWithCredentialsInput,
  type DockerCredentialsRequired,
  type DockerMongoContainer,
  type DockerMongoContainerSummary,
  type DockerStatus,
  type RpcEvent,
  type Settings,
} from '@mongo-gui/core';
import {
  FORWARDER_LABEL,
  dialHost,
  discoverMongoContainers,
  dockerStatus,
  type DockerEngineClient,
  type ForwarderManager,
  type ForwarderTls,
} from '@mongo-gui/docker';
import type { ConnectionsRepository, SettingsRepository } from '@mongo-gui/storage';
import type { Logger } from '../log';
import { staleDockerProfiles } from './prune';

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
  /** Opens a client without saving anything. Used to check credentials before a profile is written. */
  test(profile: ConnectionProfileInput): Promise<ConnectionTestResult>;
  /** The current state of a connection. An unknown id reads as disconnected. */
  status(connectionId: string): ConnectionStatus;
}

export interface DockerRuntimeDeps {
  readonly engine: DockerEngineClient;
  /** The folder for forwarder certificate folders. The app passes one under the profile's user data folder. */
  readonly tlsRoot: string;
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

export interface DockerConnectedResult {
  readonly connectionId: string;
  readonly status: ConnectionStatus;
}

/** Connected, or credentials are needed from the user. Both come from the same connect call. */
export type DockerConnectResult = DockerConnectedResult | DockerCredentialsRequired;

/** The Docker features the router exposes. Created once per app session. */
export interface DockerRuntime {
  status(): Promise<DockerStatus>;
  /** `emit` receives the event for profiles removed because their container is gone. */
  list(emit?: (event: RpcEvent) => void): Promise<DockerMongoContainerSummary[]>;
  connect(containerId: string): Promise<DockerConnectResult>;
  /** Tests the user and password first. A failed test throws its AppError and saves nothing. */
  connectWithCredentials(input: DockerConnectWithCredentialsInput): Promise<DockerConnectedResult>;
  disconnect(containerId: string): Promise<void>;
  setAutoConnect(enabled: boolean): Settings;
  /** Starts or stops the poll. Each change pushes a `docker:containers` event. */
  watch(enabled: boolean, emit: (event: RpcEvent) => void): void;
  /**
   * Removes docker profiles whose container no longer exists, including stopped ones. Does
   * nothing when Docker cannot be listed. Normally runs on every container listing, this is for unlock.
   */
  pruneMissing(emit?: (event: RpcEvent) => void): Promise<void>;
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
  /** Files holding the forwarder's certificates. Set only for a forwarded endpoint. */
  readonly tls?: TlsFiles;
}

interface TlsFiles {
  readonly caFile: string;
  readonly certFile: string;
}

/** The directory of a forwarder's certificate files, and the PEMs written into it. */
interface TlsDir {
  readonly dir: string;
  readonly caPem: string;
  readonly clientPem: string;
}

function tlsFilesIn(dir: string): TlsFiles {
  return { caFile: join(dir, 'ca.pem'), certFile: join(dir, 'client.pem') };
}

const DISCONNECTED: ConnectionStatus = { state: 'disconnected' };

/** A disconnect request for one container. A connect takes the signal when it is requested. */
interface DisconnectSignal {
  /** True once a disconnect fired this signal. */
  fired: boolean;
  readonly settled: Promise<void>;
  fire(): void;
}

function newDisconnectSignal(): DisconnectSignal {
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const signal: DisconnectSignal = {
    fired: false,
    settled,
    fire: () => {
      signal.fired = true;
      settle();
    },
  };
  return signal;
}

interface Snapshot {
  readonly available: boolean;
  readonly containers: readonly DockerMongoContainerSummary[];
}

const FORWARDER_DIR_PREFIX = 'mongo-gui-forwarder-';

/** The folder under a profile's user data folder that holds the forwarder certificate folders. */
export function forwarderTlsRoot(userDataDir: string): string {
  return join(userDataDir, 'forwarder-tls');
}

/**
 * Removes the forwarder certificate folders that an earlier run left in one TLS root, for example
 * after a crash. The app calls it at startup under the profile lock, so no folder of a live forwarder
 * in that profile is removed. Other folders, and other profiles, are not touched. Returns the number of
 * folders removed.
 */
export function sweepStaleForwarderDirs(tmp: string): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(tmp, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(FORWARDER_DIR_PREFIX)) continue;
    try {
      rmSync(join(tmp, entry.name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // A folder that cannot be removed now is tried again on the next start.
    }
  }
  return removed;
}

export function createDockerRuntime(deps: DockerRuntimeDeps): DockerRuntime {
  const pollIntervalMs = deps.pollIntervalMs ?? DOCKER_POLL_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let emitter: ((event: RpcEvent) => void) | undefined;
  // Where removals go when the poll is off. Set by the last docker.list call.
  let listEmitter: ((event: RpcEvent) => void) | undefined;
  let watching = false;
  let lastKey: string | undefined;
  let polling = false;
  // Private directories that hold the certificate files of the live forwarders, by container id.
  const tlsDirs = new Map<string, TlsDir>();

  function writeTlsFiles(containerId: string, tls: ForwarderTls): TlsFiles {
    const current = tlsDirs.get(containerId);
    // A connected profile reads these files when it reconnects. Same certificates keep the same files.
    if (
      current !== undefined &&
      current.caPem === tls.caPem &&
      current.clientPem === tls.clientPem
    ) {
      return tlsFilesIn(current.dir);
    }
    removeTlsDir(containerId);
    // mkdtemp creates the directory with mode 0700. The files are owner-only too.
    mkdirSync(deps.tlsRoot, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(deps.tlsRoot, FORWARDER_DIR_PREFIX));
    tlsDirs.set(containerId, { dir, caPem: tls.caPem, clientPem: tls.clientPem });
    const files = tlsFilesIn(dir);
    writeFileSync(files.caFile, tls.caPem, { mode: 0o600 });
    writeFileSync(files.certFile, tls.clientPem, { mode: 0o600 });
    return files;
  }

  function removeTlsDir(containerId: string): void {
    const current = tlsDirs.get(containerId);
    if (current !== undefined) {
      rmSync(current.dir, { recursive: true, force: true });
      tlsDirs.delete(containerId);
    }
  }

  async function releaseForwarder(containerId: string): Promise<void> {
    try {
      await deps.forwarders.release(containerId);
    } finally {
      removeTlsDir(containerId);
    }
  }

  async function cleanupForwardersAndFiles(): Promise<void> {
    await cleanupForwarders(deps.forwarders, deps.log);
    for (const containerId of [...tlsDirs.keys()]) {
      removeTlsDir(containerId);
    }
  }

  /** One container listing serves both discovery and the removal of profiles of gone containers. */
  const discover = async (): Promise<DockerMongoContainer[]> => {
    const items = await deps.engine.listContainers();
    await pruneProfiles(new Set(items.map((item) => item.id)));
    return discoverMongoContainers({ ...deps.engine, listContainers: async () => items });
  };

  // Removals run one at a time, so two listings that overlap never delete the same profile twice.
  let pruning: Promise<void> = Promise.resolve();

  function pruneProfiles(
    containerIds: ReadonlySet<string>,
    emit: ((event: RpcEvent) => void) | undefined = emitter ?? listEmitter,
  ): Promise<void> {
    pruning = pruning.then(() => removeStaleProfiles(containerIds, emit));
    return pruning;
  }

  async function removeStaleProfiles(
    containerIds: ReadonlySet<string>,
    emit: ((event: RpcEvent) => void) | undefined = emitter,
  ): Promise<void> {
    try {
      if (!deps.isUnlocked()) {
        return;
      }
      const repos = deps.repos();
      const removed: { id: string; name: string }[] = [];
      for (const profile of staleDockerProfiles(repos.connections.list(), containerIds)) {
        // Disconnect and free the forwarder first, then delete the profile as connections.remove does.
        await deps.connections.disconnect(profile.id);
        if (profile.dockerContainerId !== undefined) {
          await releaseForwarder(profile.dockerContainerId);
        }
        repos.connections.remove(profile.id);
        deps.log.info('removed docker connection whose container is gone', {
          name: profile.name,
          containerId: profile.dockerContainerId ?? '',
        });
        removed.push({ id: profile.id, name: profile.name });
      }
      if (removed.length > 0) {
        emit?.({ type: 'connections:changed', removed });
      }
    } catch (error) {
      deps.log.warn('removing docker connections failed', { error: errorText(error) });
    }
  }

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

  /** Resolves a container that must be running. Called inside the queue, so the state is read at the start of the task. */
  async function runningContainer(containerId: string): Promise<DockerMongoContainer> {
    const container = await resolveContainer(containerId);
    if (container.state !== 'running') {
      throw new AppErrorException(appError('COMMAND_FAILED', 'The container is not running.'));
    }
    return container;
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
      return { host: LOOPBACK, port: container.internalPort, forwarded: false };
    }
    const handle = await deps.forwarders.ensure(container);
    return {
      host: LOOPBACK,
      port: handle.hostPort,
      forwarded: true,
      tls: writeTlsFiles(container.id, handle.tls),
    };
  }

  function saveProfile(
    container: DockerMongoContainer,
    uri: string,
    tls: Endpoint['tls'],
  ): ConnectionProfile {
    const repos = deps.repos();
    const existing = findProfile(container.id);
    if (existing !== undefined) {
      return repos.connections.update(existing.id, { name: container.name, uri, tls: tlsOf(tls) });
    }
    return repos.connections.create({
      name: container.name,
      uri,
      tls: tlsOf(tls),
      source: 'docker',
      dockerContainerId: container.id,
    });
  }

  // The last queued task for each container. connect, connectWithCredentials and disconnect wait for it.
  const inFlight = new Map<string, Promise<unknown>>();

  /** Runs `task` after the queued task for the same container settles, so attempts never overlap. */
  function afterInFlight<T>(containerId: string, task: () => Promise<T>): Promise<T> {
    const previous = inFlight.get(containerId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    inFlight.set(containerId, run);
    return run.finally(() => {
      if (inFlight.get(containerId) === run) {
        inFlight.delete(containerId);
      }
    });
  }

  /** True when the container's profile is connected, so its forwarder is still in use. */
  function profileConnected(containerId: string): boolean {
    const profile = findProfile(containerId);
    return profile !== undefined && deps.connections.status(profile.id).state === 'connected';
  }

  // The signal each container's connects wait on. A disconnect fires and removes it, so later connects get a new one.
  const disconnectSignals = new Map<string, DisconnectSignal>();

  function disconnectSignalFor(containerId: string): DisconnectSignal {
    let signal = disconnectSignals.get(containerId);
    if (signal === undefined) {
      signal = newDisconnectSignal();
      disconnectSignals.set(containerId, signal);
    }
    return signal;
  }

  /**
   * Starts the connection unless a disconnect was requested first. The disconnect ends the wait at
   * once. A stuck attempt in the connection manager does not end by itself.
   */
  function connectUnlessDisconnected(
    profile: ConnectionProfile,
    signal: DisconnectSignal,
  ): Promise<ConnectionStatus> {
    if (signal.fired) {
      return Promise.resolve(DISCONNECTED);
    }
    return Promise.race([
      deps.connections.connect(profile),
      signal.settled.then(() => DISCONNECTED),
    ]);
  }

  async function connect(containerId: string): Promise<DockerConnectResult> {
    const signal = disconnectSignalFor(containerId);
    return afterInFlight(containerId, async () =>
      connectResolved(await runningContainer(containerId), signal),
    );
  }

  async function connectResolved(
    container: DockerMongoContainer,
    signal: DisconnectSignal,
  ): Promise<DockerConnectResult> {
    const endpoint = await endpointFor(container);
    try {
      const profile = saveProfile(container, buildUri(container, endpoint), endpoint.tls);
      const status = await connectUnlessDisconnected(profile, signal);
      if (status.state === 'error' && endpoint.forwarded) {
        await releaseForwarder(container.id);
      }
      const hasEnvCredentials = envHasCredentials(container);
      if (status.state === 'error' && needsCredentials(status.error, hasEnvCredentials)) {
        return {
          kind: 'credentialsRequired',
          containerId: container.id,
          host: endpoint.host,
          port: endpoint.port,
          hint: hasEnvCredentials ? 'envFound' : 'noEnv',
        };
      }
      return { connectionId: profile.id, status };
    } catch (error) {
      // A failure after the forwarder started would leave it running with no owner. A connected profile still owns it.
      if (endpoint.forwarded && !profileConnected(container.id)) {
        await releaseForwarder(container.id).catch(() => undefined);
      }
      throw error;
    }
  }

  async function connectWithCredentials(
    input: DockerConnectWithCredentialsInput,
  ): Promise<DockerConnectedResult> {
    const signal = disconnectSignalFor(input.containerId);
    return afterInFlight(input.containerId, async () =>
      connectWithCredentialsResolved(await runningContainer(input.containerId), input, signal),
    );
  }

  async function connectWithCredentialsResolved(
    container: DockerMongoContainer,
    input: DockerConnectWithCredentialsInput,
    signal: DisconnectSignal,
  ): Promise<DockerConnectedResult> {
    const endpoint = await endpointFor(container);
    try {
      const uri = buildCredentialsUri(endpoint, input);
      const tested = await deps.connections.test({
        name: container.name,
        uri,
        tls: tlsOf(endpoint.tls),
        source: 'docker',
        dockerContainerId: container.id,
      });
      if (!tested.ok) {
        throw new AppErrorException(tested.error);
      }
      const profile = saveProfile(container, uri, endpoint.tls);
      const status = await connectUnlessDisconnected(profile, signal);
      if (status.state === 'error' && endpoint.forwarded) {
        await releaseForwarder(container.id);
      }
      return { connectionId: profile.id, status };
    } catch (error) {
      if (endpoint.forwarded && !profileConnected(container.id)) {
        await releaseForwarder(container.id).catch(() => undefined);
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

    async list(emit) {
      if (emit !== undefined) {
        listEmitter = emit;
      }
      try {
        return (await discover()).map(toDockerContainerSummary);
      } catch (error) {
        deps.log.warn('docker container list failed', {
          error: errorText(error),
          ...(error instanceof AppErrorException && error.error.detail !== undefined
            ? { detail: error.error.detail }
            : {}),
        });
        throw error;
      }
    },

    connect,

    connectWithCredentials,

    async disconnect(containerId) {
      // The signal fires before the queue, so a connect that is stuck or waiting for its forwarder cannot hold this up.
      disconnectSignals.get(containerId)?.fire();
      disconnectSignals.delete(containerId);
      // Queued before the first await. A connect that arrives while the close runs then waits for the release.
      const released = afterInFlight(containerId, () => releaseForwarder(containerId));
      const profile = findProfile(containerId);
      if (profile !== undefined) {
        await deps.connections.disconnect(profile.id);
      }
      await released;
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

    async pruneMissing(emit) {
      try {
        const items = await deps.engine.listContainers();
        await pruneProfiles(new Set(items.map((item) => item.id)), emit ?? emitter ?? listEmitter);
      } catch {
        // Docker is not reachable, so nothing is removed.
      }
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
        await releaseForwarder(profile.dockerContainerId);
      }
    },

    cleanupAll: cleanupForwardersAndFiles,

    async dispose() {
      stopTimer();
      watching = false;
      await cleanupForwardersAndFiles();
    },
  };
}

/** The TLS profile for a forwarded endpoint. A direct endpoint keeps the connection's own TLS state. */
function tlsOf(files: TlsFiles | undefined): ConnectionProfileInput['tls'] {
  return files === undefined ? undefined : { enabled: true, ...files };
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

/**
 * Builds a URI from credentials the user typed. The user and password are percent-encoded, and
 * the authentication database comes from the dialog.
 */
function buildCredentialsUri(
  endpoint: Endpoint,
  credentials: DockerConnectWithCredentialsInput,
): string {
  const auth = `${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@`;
  const host = endpoint.host.includes(IPV6_HOST_MARKER) ? `[${endpoint.host}]` : endpoint.host;
  const authSource = encodeURIComponent(credentials.authSource);
  return `mongodb://${auth}${host}:${endpoint.port}/?directConnection=true&authSource=${authSource}`;
}

function envHasCredentials(container: DockerMongoContainer): boolean {
  return container.env.username !== undefined && container.env.password !== undefined;
}

/**
 * An auth failure means the server wants credentials. Code 13 (Unauthorized) counts only when no
 * credentials were sent, because with credentials it means the user lacks a privilege.
 */
function needsCredentials(error: AppError, hasEnvCredentials: boolean): boolean {
  if (error.code === 'AUTH_FAILED') {
    return true;
  }
  return !hasEnvCredentials && error.codeName === 'Unauthorized';
}

function errorText(error: unknown): string {
  return error instanceof AppErrorException ? error.error.message : 'unexpected error';
}
