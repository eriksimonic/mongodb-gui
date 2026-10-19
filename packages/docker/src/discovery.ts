import { z } from 'zod';
import {
  type DockerContainerState,
  type DockerMongoContainer,
  type DockerPublishedPort,
  type DockerStatus,
} from '@mongo-gui/core';
import { DockerEngineError, type DockerEngineClient } from './engine-client';

export const MONGO_PORT = 27017;
export const MONGO_PORT_KEY = '27017/tcp';
export const FORWARDER_LABEL = 'mongo-gui.forwarder';

/** Loopback first, then the wildcard bindings. Any other host IP comes last. */
const HOST_IP_PREFERENCE: readonly string[] = ['127.0.0.1', '0.0.0.0', '::'];
const WILDCARD_HOST_IPS: readonly string[] = ['0.0.0.0', '::'];
const LOOPBACK = '127.0.0.1';

const BindingSchema = z.object({ HostIp: z.string(), HostPort: z.string() });

const InspectSchema = z.object({
  Id: z.string().min(1),
  Name: z.string(),
  Config: z.object({
    Image: z.string(),
    Env: z.array(z.string()).nullish(),
    Labels: z.record(z.string(), z.string()).nullish(),
  }),
  State: z.object({ Status: z.string() }),
  NetworkSettings: z.object({
    Ports: z.record(z.string(), z.array(BindingSchema).nullish()).nullish(),
    Networks: z.record(z.string(), z.object({ IPAddress: z.string().nullish() })).nullish(),
  }),
});

const NetworkAddressSchema = z.object({
  NetworkSettings: z.object({
    Networks: z.record(z.string(), z.object({ IPAddress: z.string().nullish() })).nullish(),
  }),
});

type Inspect = z.infer<typeof InspectSchema>;

function hostPortOf(binding: z.infer<typeof BindingSchema>): number | undefined {
  if (!/^\d+$/.test(binding.HostPort)) {
    return undefined;
  }
  const port = Number(binding.HostPort);
  return port > 0 ? port : undefined;
}

/** Picks the published binding to connect through, preferring loopback over wildcard bindings. */
function pickPublishedPort(
  bindings: readonly z.infer<typeof BindingSchema>[] | null | undefined,
): DockerPublishedPort | undefined {
  const usable = (bindings ?? []).flatMap((binding) => {
    const hostPort = hostPortOf(binding);
    return hostPort === undefined ? [] : [{ hostIp: binding.HostIp, hostPort }];
  });
  const rank = (hostIp: string): number => {
    const index = HOST_IP_PREFERENCE.indexOf(hostIp);
    return index === -1 ? HOST_IP_PREFERENCE.length : index;
  };
  const sorted = [...usable].sort((a, b) => rank(a.hostIp) - rank(b.hostIp));
  return sorted[0];
}

/** The port from a `--port N` or `--port=N` argument, or undefined when there is none. */
function portArgument(args: readonly string[]): number | undefined {
  for (const [index, arg] of args.entries()) {
    const value = arg === '--port' ? args[index + 1] : /^--port=(.*)$/.exec(arg)?.[1];
    if (value !== undefined && /^\d+$/.test(value) && Number(value) > 0) {
      return Number(value);
    }
  }
  return undefined;
}

const MONGO_PROCESS_NAMES: readonly string[] = ['mongod', 'mongos'];

/** The port of the first mongod or mongos command line in a process list, or undefined if none. */
function mongoProcessPort(commands: readonly string[]): number | undefined {
  for (const command of commands) {
    const [executable = '', ...args] = command.trim().split(/\s+/);
    const name = executable.split('/').pop() ?? '';
    if (MONGO_PROCESS_NAMES.includes(name)) {
      return portArgument(args) ?? MONGO_PORT;
    }
  }
  return undefined;
}

function envMap(entries: readonly string[] | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries ?? []) {
    const separator = entry.indexOf('=');
    if (separator > 0) {
      map.set(entry.slice(0, separator), entry.slice(separator + 1));
    }
  }
  return map;
}

/** Returns the first non-empty value among the given variable names. */
function firstValue(
  env: ReadonlyMap<string, string>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = env.get(name);
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return undefined;
}

function stateOf(status: string): DockerContainerState {
  switch (status) {
    case 'running':
    case 'exited':
    case 'paused':
    case 'restarting':
      return status;
    default:
      return 'other';
  }
}

/**
 * Maps `docker inspect` JSON to a MongoDB container. Returns undefined when no process of the
 * container is a mongod or mongos, or when it is a forwarder this app started. The mongod command
 * line gives the port, so any image name works. Pure: no I/O.
 */
export function toMongoContainer(
  inspectJson: unknown,
  processCommands: readonly string[],
): DockerMongoContainer | undefined {
  const parsed = InspectSchema.safeParse(inspectJson);
  if (!parsed.success) {
    return undefined;
  }
  const inspect: Inspect = parsed.data;
  if (inspect.Config.Labels?.[FORWARDER_LABEL] !== undefined) {
    return undefined;
  }
  const internalPort = mongoProcessPort(processCommands);
  if (internalPort === undefined) {
    return undefined;
  }
  const portKey = `${internalPort}/tcp`;

  const env = envMap(inspect.Config.Env);
  const username = firstValue(env, ['MONGO_INITDB_ROOT_USERNAME', 'MONGODB_ROOT_USER']);
  const password = firstValue(env, ['MONGO_INITDB_ROOT_PASSWORD', 'MONGODB_ROOT_PASSWORD']);
  const database = firstValue(env, ['MONGO_INITDB_DATABASE']);
  const publishedPort = pickPublishedPort(inspect.NetworkSettings.Ports?.[portKey]);

  return {
    id: inspect.Id,
    name: inspect.Name.replace(/^\//, ''),
    image: inspect.Config.Image,
    state: stateOf(inspect.State.Status),
    ...(publishedPort === undefined ? {} : { publishedPort }),
    internalPort,
    networks: Object.keys(inspect.NetworkSettings.Networks ?? {}).sort(),
    env: {
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password }),
      ...(database === undefined ? {} : { database }),
    },
    envKeys: [...env.keys()].sort(),
  };
}

/** The address a container has on one of its networks, or undefined when it has none there. */
export function networkAddress(inspectJson: unknown, network: string): string | undefined {
  const parsed = NetworkAddressSchema.safeParse(inspectJson);
  if (!parsed.success) {
    return undefined;
  }
  const address = parsed.data.NetworkSettings.Networks?.[network]?.IPAddress;
  return address === undefined || address === null || address === '' ? undefined : address;
}

/** The host a client should dial for a published binding. Wildcard bindings dial loopback. */
export function dialHost(publishedPort: DockerPublishedPort): string {
  return WILDCARD_HOST_IPS.includes(publishedPort.hostIp) ? LOOPBACK : publishedPort.hostIp;
}

/**
 * Lists the running MongoDB containers on the engine. Each running container is asked for its
 * process list, and one with a mongod or mongos is inspected for its env, networks and bindings.
 * Stopped containers are not listed. This costs one call per container, which suits a developer
 * machine.
 */
export async function discoverMongoContainers(
  client: DockerEngineClient,
): Promise<DockerMongoContainer[]> {
  const items = await client.listContainers();
  const found: DockerMongoContainer[] = [];
  for (const item of items) {
    if (item.state !== 'running' || item.labels[FORWARDER_LABEL] !== undefined) {
      continue;
    }
    const commands = await processesOrEmpty(client, item.id);
    const container = await inspectOrSkip(client, item.id, commands);
    if (container !== undefined) {
      found.push(container);
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** A container that cannot list its processes (removed, no ps available) has none to show. */
async function processesOrEmpty(client: DockerEngineClient, id: string): Promise<string[]> {
  try {
    return await client.processCommands(id);
  } catch (error) {
    if (error instanceof DockerEngineError) {
      return [];
    }
    throw error;
  }
}

async function inspectOrSkip(
  client: DockerEngineClient,
  id: string,
  processCommands: readonly string[],
): Promise<DockerMongoContainer | undefined> {
  try {
    return toMongoContainer(await client.inspectContainer(id), processCommands);
  } catch (error) {
    // The container was removed between the list and the inspect. It is no longer a candidate.
    if (error instanceof DockerEngineError && error.statusCode === 404) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Reports whether the engine answers. The reason names the socket that was tried, so a wrong
 * DOCKER_HOST or a missing daemon is easy to spot. Permission errors get a hint about the group.
 */
export async function dockerStatus(
  client: DockerEngineClient,
  socketPath: string,
): Promise<DockerStatus> {
  try {
    const version = await client.version();
    return { available: true, engineVersion: version.version };
  } catch (error) {
    return { available: false, reason: describeFailure(error, socketPath) };
  }
}

const PERMISSION_CODES: readonly string[] = ['EACCES', 'EPERM'];

function describeFailure(error: unknown, socketPath: string): string {
  if (error instanceof DockerEngineError) {
    const detail = error.error.detail;
    if (detail !== undefined && PERMISSION_CODES.includes(detail)) {
      return `Permission denied on ${socketPath}. Add your user to the docker group, then sign in again.`;
    }
    if (error.error.message === 'Docker is not reachable.') {
      return `Docker is not reachable at ${socketPath}${detail === undefined ? '' : ` (${detail})`}.`;
    }
    const { message } = error.error;
    return detail === undefined ? message : `${message} (${detail})`;
  }
  return `Docker is not available at ${socketPath}.`;
}
