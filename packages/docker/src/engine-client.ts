import { request, type IncomingMessage } from 'node:http';
import { z } from 'zod';
import { AppErrorException, appError } from '@mongo-gui/core';

export const DEFAULT_DOCKER_TIMEOUT_MS = 5_000;
const LINUX_SOCKET = '/var/run/docker.sock';
const WINDOWS_PIPE = '//./pipe/docker_engine';
const UNIX_PREFIX = 'unix://';
const MAX_DETAIL_LENGTH = 200;
const UNREACHABLE_CODES: readonly string[] = ['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPERM'];

/** An Engine API failure. It is an AppErrorException with code INTERNAL, so the router passes it on. */
export class DockerEngineError extends AppErrorException {
  readonly statusCode: number | undefined;

  constructor(message: string, detail?: string, statusCode?: number) {
    super(appError('INTERNAL', message, detail));
    this.name = 'DockerEngineError';
    this.statusCode = statusCode;
  }
}

/**
 * Picks the Engine socket. `DOCKER_HOST` counts only when it is a `unix://` URL. Any other value
 * is ignored, so the default socket is tried and the status reason shows which path failed.
 */
export function defaultDockerSocket(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string {
  const host = env['DOCKER_HOST'];
  if (host !== undefined && host.startsWith(UNIX_PREFIX) && host.length > UNIX_PREFIX.length) {
    return host.slice(UNIX_PREFIX.length);
  }
  return platform === 'win32' ? WINDOWS_PIPE : LINUX_SOCKET;
}

export interface DockerEngineClientOptions {
  readonly socketPath: string;
  /** Maximum silence on the socket before a request fails. Defaults to 5 seconds. */
  readonly timeoutMs?: number;
}

/** One entry of `GET /containers/json`, reduced to the fields discovery uses. */
export interface ContainerListItem {
  readonly id: string;
  readonly names: readonly string[];
  readonly image: string;
  readonly state: string;
  readonly labels: Readonly<Record<string, string>>;
  /** Private (container side) TCP ports the container exposes or publishes. */
  readonly ports: readonly number[];
}

export interface EngineVersion {
  readonly version: string;
  readonly apiVersion: string;
}

export interface ContainerCreateSpec {
  readonly name?: string;
  readonly image: string;
  readonly cmd?: readonly string[];
  readonly labels?: Readonly<Record<string, string>>;
  /** Container ports in the form `27017/tcp`. */
  readonly exposedPorts?: readonly string[];
  readonly networkMode?: string;
  /** Maps a container port such as `27017/tcp` to host bindings. Host port `0` picks a free port. */
  readonly portBindings?: Readonly<
    Record<string, readonly { readonly hostIp: string; readonly hostPort: string }[]>
  >;
  readonly autoRemove?: boolean;
}

export interface DockerEngineClient {
  ping(): Promise<void>;
  version(): Promise<EngineVersion>;
  listContainers(): Promise<ContainerListItem[]>;
  listContainersByLabel(label: string): Promise<ContainerListItem[]>;
  /** Returns the raw `docker inspect` JSON. Callers validate it before use. */
  inspectContainer(id: string): Promise<unknown>;
  createContainer(spec: ContainerCreateSpec): Promise<string>;
  startContainer(id: string): Promise<void>;
  /** Removes a container. A container that is already gone counts as removed. */
  removeContainer(id: string, force: boolean): Promise<void>;
  hasImage(reference: string): Promise<boolean>;
  /** Pulls an image and resolves once the engine reports the pull is done. */
  pullImage(reference: string): Promise<void>;
}

const VersionSchema = z.object({ Version: z.string(), ApiVersion: z.string() });

const ContainerListSchema = z.array(
  z.object({
    Id: z.string().min(1),
    Names: z.array(z.string()).nullish(),
    Image: z.string(),
    State: z.string(),
    Labels: z.record(z.string(), z.string()).nullish(),
    Ports: z
      .array(z.object({ PrivatePort: z.number().int(), Type: z.string().optional() }))
      .nullish(),
  }),
);

const CreateSchema = z.object({ Id: z.string().min(1) });
const PullLineSchema = z.object({ error: z.string().optional() });
const ErrorBodySchema = z.object({ message: z.string().optional() });

interface Reply {
  readonly status: number;
  readonly text: string;
}

interface CallOptions {
  readonly body?: unknown;
  /** Statuses at or above 400 that the caller handles itself. */
  readonly allow?: readonly number[];
}

export function createDockerEngineClient(options: DockerEngineClientOptions): DockerEngineClient {
  const { socketPath } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOCKER_TIMEOUT_MS;

  const send = async (
    method: string,
    path: string,
    callOptions: CallOptions = {},
  ): Promise<Reply> => {
    const response = await exchange(socketPath, timeoutMs, method, path, callOptions.body);
    const text = await readText(response);
    const status = response.statusCode ?? 0;
    if (status >= 400 && !(callOptions.allow ?? []).includes(status)) {
      throw httpError(status, text);
    }
    return { status, text };
  };

  const listWith = async (path: string): Promise<ContainerListItem[]> => {
    const { text } = await send('GET', path);
    return parse(ContainerListSchema, text, 'container list').map((item) => ({
      id: item.Id,
      names: item.Names ?? [],
      image: item.Image,
      state: item.State,
      labels: item.Labels ?? {},
      ports: (item.Ports ?? [])
        .filter((port) => port.Type === 'tcp')
        .map((port) => port.PrivatePort),
    }));
  };

  return {
    async ping() {
      await send('GET', '/_ping');
    },

    async version() {
      const { text } = await send('GET', '/version');
      const parsed = parse(VersionSchema, text, 'version');
      return { version: parsed.Version, apiVersion: parsed.ApiVersion };
    },

    listContainers() {
      return listWith('/containers/json?all=true');
    },

    listContainersByLabel(label) {
      const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
      return listWith(`/containers/json?all=true&filters=${filters}`);
    },

    async inspectContainer(id) {
      const { text } = await send('GET', `/containers/${encodeURIComponent(id)}/json`);
      return parseUnknown(text, 'container inspect');
    },

    async createContainer(spec) {
      const body = toCreateBody(spec);
      const name = spec.name === undefined ? '' : `?name=${encodeURIComponent(spec.name)}`;
      const { text } = await send('POST', `/containers/create${name}`, { body });
      return parse(CreateSchema, text, 'create response').Id;
    },

    async startContainer(id) {
      // 304 means the container was already running, which is the state the caller wants.
      await send('POST', `/containers/${encodeURIComponent(id)}/start`, { allow: [304] });
    },

    async removeContainer(id, force) {
      const query = `force=${force ? 'true' : 'false'}&v=true`;
      await send('DELETE', `/containers/${encodeURIComponent(id)}?${query}`, { allow: [404] });
    },

    async hasImage(reference) {
      const { status } = await send('GET', `/images/${encodeURIComponent(reference)}/json`, {
        allow: [404],
      });
      return status === 200;
    },

    async pullImage(reference) {
      const { repository, tag } = splitReference(reference);
      const path = `/images/create?fromImage=${encodeURIComponent(repository)}&tag=${encodeURIComponent(tag)}`;
      const response = await exchange(socketPath, timeoutMs, 'POST', path);
      const status = response.statusCode ?? 0;
      if (status >= 400) {
        throw httpError(status, await readText(response));
      }
      let failure: string | undefined;
      await readLines(response, (line) => {
        const parsed = PullLineSchema.safeParse(parseJsonOrUndefined(line));
        if (parsed.success && parsed.data.error !== undefined && failure === undefined) {
          failure = parsed.data.error;
        }
      });
      if (failure !== undefined) {
        throw new DockerEngineError('Docker could not pull the image.', truncate(failure));
      }
    },
  };
}

function exchange(
  socketPath: string,
  timeoutMs: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const req = request({ socketPath, path, method, headers, agent: false, timeout: timeoutMs });
    req.once('timeout', () => {
      req.destroy(new TimeoutSignal());
    });
    req.once('error', (error: unknown) => {
      reject(toEngineError(error));
    });
    req.once('response', (response) => {
      resolve(response);
    });
    req.end(payload);
  });
}

class TimeoutSignal extends Error {
  constructor() {
    super('timeout');
    this.name = 'TimeoutSignal';
  }
}

function readText(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise<string>((resolve, reject) => {
    response.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    response.once('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    response.once('error', (error: unknown) => {
      reject(toEngineError(error));
    });
    response.once('close', () => {
      if (!response.complete) {
        reject(toEngineError(new TimeoutSignal()));
      }
    });
  });
}

/** Calls onLine for each complete line as the body arrives. Resolves when the body ends. */
function readLines(response: IncomingMessage, onLine: (line: string) => void): Promise<void> {
  let pending = '';
  return new Promise<void>((resolve, reject) => {
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() !== '') {
          onLine(line);
        }
      }
    });
    response.once('end', () => {
      if (pending.trim() !== '') {
        onLine(pending);
      }
      resolve();
    });
    response.once('error', (error: unknown) => {
      reject(toEngineError(error));
    });
    response.once('close', () => {
      if (!response.complete) {
        reject(toEngineError(new TimeoutSignal()));
      }
    });
  });
}

function toEngineError(error: unknown): DockerEngineError {
  if (error instanceof TimeoutSignal) {
    return new DockerEngineError('Docker did not respond in time.', 'timeout');
  }
  const code = errorCode(error);
  if (code !== undefined && UNREACHABLE_CODES.includes(code)) {
    return new DockerEngineError('Docker is not reachable.', code);
  }
  return new DockerEngineError('Docker request failed.', code ?? 'unknown');
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function httpError(status: number, text: string): DockerEngineError {
  const parsed = ErrorBodySchema.safeParse(parseJsonOrUndefined(text));
  const detail = parsed.success ? parsed.data.message : undefined;
  return new DockerEngineError(
    `Docker returned HTTP ${status}.`,
    detail === undefined ? undefined : truncate(detail),
    status,
  );
}

function parse<T>(schema: z.ZodType<T>, text: string, what: string): T {
  const parsed = schema.safeParse(parseJsonOrUndefined(text));
  if (!parsed.success) {
    throw new DockerEngineError('Docker returned an unexpected response.', what);
  }
  return parsed.data;
}

function parseUnknown(text: string, what: string): unknown {
  const value = parseJsonOrUndefined(text);
  if (value === undefined) {
    throw new DockerEngineError('Docker returned an unexpected response.', what);
  }
  return value;
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function truncate(text: string): string {
  return text.length <= MAX_DETAIL_LENGTH ? text : `${text.slice(0, MAX_DETAIL_LENGTH)}...`;
}

function splitReference(reference: string): { repository: string; tag: string } {
  const colon = reference.lastIndexOf(':');
  if (colon > reference.lastIndexOf('/')) {
    return { repository: reference.slice(0, colon), tag: reference.slice(colon + 1) };
  }
  return { repository: reference, tag: 'latest' };
}

function toCreateBody(spec: ContainerCreateSpec): Record<string, unknown> {
  const exposed = Object.fromEntries((spec.exposedPorts ?? []).map((port) => [port, {}]));
  const bindings = Object.entries(spec.portBindings ?? {}).map(([port, list]) => [
    port,
    list.map((binding) => ({ HostIp: binding.hostIp, HostPort: binding.hostPort })),
  ]);
  return {
    Image: spec.image,
    ...(spec.cmd === undefined ? {} : { Cmd: [...spec.cmd] }),
    ...(spec.labels === undefined ? {} : { Labels: { ...spec.labels } }),
    ExposedPorts: exposed,
    HostConfig: {
      AutoRemove: spec.autoRemove ?? false,
      ...(spec.networkMode === undefined ? {} : { NetworkMode: spec.networkMode }),
      PortBindings: Object.fromEntries(bindings),
    },
  };
}
