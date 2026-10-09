import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppErrorException } from '@mongo-gui/core';
import {
  DockerEngineError,
  createDockerEngineClient,
  defaultDockerSocket,
  type DockerEngineClient,
} from './engine-client';

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

let dir: string;
let socketPath: string;
let server: Server | undefined;
let recorded: Recorded[];

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

/** Starts a fake Engine API on a temporary Unix socket. Each request goes to the handler. */
function startServer(handler: Handler): Promise<void> {
  server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      recorded.push({ method: request.method ?? '', url: request.url ?? '', body });
      handler(request, response, body);
    });
  });
  return new Promise((resolve) => {
    server?.listen(socketPath, resolve);
  });
}

function clientWith(timeoutMs?: number): DockerEngineClient {
  return createDockerEngineClient(
    timeoutMs === undefined ? { socketPath } : { socketPath, timeoutMs },
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'docker-engine-'));
  socketPath = join(dir, 'docker.sock');
  recorded = [];
});

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
      server?.closeAllConnections();
    });
    server = undefined;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('DockerEngineClient against a fake engine', () => {
  it('answers ping with OK from the _ping route', async () => {
    await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('OK');
    });

    await clientWith().ping();

    expect(recorded).toEqual([{ method: 'GET', url: '/_ping', body: '' }]);
  });

  it('reads the engine version', async () => {
    await startServer((_request, response) => {
      json(response, 200, { Version: '29.8.2', ApiVersion: '1.54', Os: 'linux' });
    });

    expect(await clientWith().version()).toEqual({ version: '29.8.2', apiVersion: '1.54' });
  });

  it('lists every container and reduces each entry to the fields discovery needs', async () => {
    await startServer((_request, response) => {
      json(response, 200, [
        {
          Id: 'abc',
          Names: null,
          Image: 'mongo:7',
          State: 'exited',
          Labels: null,
          Ports: [
            { PrivatePort: 27017, Type: 'tcp' },
            { PrivatePort: 53, Type: 'udp' },
          ],
        },
      ]);
    });

    const items = await clientWith().listContainers();

    expect(recorded[0]?.url).toBe('/containers/json?all=true');
    expect(items).toEqual([
      { id: 'abc', names: [], image: 'mongo:7', state: 'exited', labels: {}, ports: [27017] },
    ]);
  });

  it('filters the list by label with a JSON filter in the query', async () => {
    await startServer((_request, response) => {
      json(response, 200, []);
    });

    await clientWith().listContainersByLabel('mongo-gui.forwarder=abc');

    const query = recorded[0]?.url ?? '';
    expect(new URL(query, 'http://x').searchParams.get('filters')).toBe(
      '{"label":["mongo-gui.forwarder=abc"]}',
    );
  });

  it('returns the raw inspect JSON', async () => {
    await startServer((_request, response) => {
      json(response, 200, { Id: 'abc', Name: '/db' });
    });

    expect(await clientWith().inspectContainer('abc')).toEqual({ Id: 'abc', Name: '/db' });
    expect(recorded[0]?.url).toBe('/containers/abc/json');
  });

  it('encodes the container id in the path', async () => {
    await startServer((_request, response) => {
      json(response, 200, {});
    });

    await clientWith().inspectContainer('a/b?c');

    expect(recorded[0]?.url).toBe('/containers/a%2Fb%3Fc/json');
  });

  it('maps an HTTP error to an INTERNAL AppError with the engine message as detail', async () => {
    await startServer((_request, response) => {
      json(response, 500, { message: 'something broke' });
    });

    const error = await clientWith()
      .inspectContainer('abc')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DockerEngineError);
    expect(error).toBeInstanceOf(AppErrorException);
    expect(error).toMatchObject({
      statusCode: 500,
      error: { code: 'INTERNAL', message: 'Docker returned HTTP 500.', detail: 'something broke' },
    });
  });

  it('keeps the status code of a missing container', async () => {
    await startServer((_request, response) => {
      json(response, 404, { message: 'No such container: abc' });
    });

    await expect(clientWith().inspectContainer('abc')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('posts the create body with labels, port bindings and network', async () => {
    await startServer((request, response) => {
      if (request.url?.startsWith('/containers/create')) {
        json(response, 201, { Id: 'new-id', Warnings: [] });
        return;
      }
      response.writeHead(500);
      response.end();
    });

    const id = await clientWith().createContainer({
      name: 'forwarder-1',
      image: 'alpine/socat:latest',
      cmd: ['tcp-listen:27017,fork,reuseaddr', 'tcp-connect:db:27017'],
      labels: { 'mongo-gui.forwarder': 'target' },
      exposedPorts: ['27017/tcp'],
      networkMode: 'app_net',
      portBindings: { '27017/tcp': [{ hostIp: '127.0.0.1', hostPort: '0' }] },
    });

    expect(id).toBe('new-id');
    expect(recorded[0]?.url).toBe('/containers/create?name=forwarder-1');
    expect(JSON.parse(recorded[0]?.body ?? '')).toEqual({
      Image: 'alpine/socat:latest',
      Cmd: ['tcp-listen:27017,fork,reuseaddr', 'tcp-connect:db:27017'],
      Labels: { 'mongo-gui.forwarder': 'target' },
      ExposedPorts: { '27017/tcp': {} },
      HostConfig: {
        AutoRemove: false,
        NetworkMode: 'app_net',
        PortBindings: { '27017/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] },
      },
    });
  });

  it('treats an already running container as started', async () => {
    await startServer((_request, response) => {
      response.writeHead(304);
      response.end();
    });

    await expect(clientWith().startContainer('abc')).resolves.toBeUndefined();
  });

  it('treats a container that is already gone as removed', async () => {
    await startServer((_request, response) => {
      json(response, 404, { message: 'No such container' });
    });

    await expect(clientWith().removeContainer('abc', true)).resolves.toBeUndefined();
    expect(recorded[0]?.url).toBe('/containers/abc?force=true&v=true');
  });

  it('reports whether an image is present', async () => {
    await startServer((request, response) => {
      if (request.url === '/images/alpine%3Alatest/json') {
        json(response, 200, { Id: 'sha' });
        return;
      }
      json(response, 404, { message: 'No such image' });
    });

    expect(await clientWith().hasImage('alpine:latest')).toBe(true);
    expect(await clientWith().hasImage('missing:1')).toBe(false);
  });

  it('pulls an image by streaming progress lines until the pull ends', async () => {
    await startServer((request, response) => {
      expect(request.url).toBe('/images/create?fromImage=alpine%2Fsocat&tag=latest');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"status":"Pulling from alpine/socat"}\n{"status":"Pulling fs');
      setTimeout(() => {
        response.write('layer"}\n{"status":"Status: Downloaded newer image"}\n');
        response.end();
      }, 10);
    });

    await expect(clientWith().pullImage('alpine/socat:latest')).resolves.toBeUndefined();
  });

  it('rejects a pull when the stream reports an error line', async () => {
    await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":"Pulling"}\n{"error":"manifest unknown"}\n');
    });

    await expect(clientWith().pullImage('alpine/nope:latest')).rejects.toMatchObject({
      error: {
        code: 'INTERNAL',
        message: 'Docker could not pull the image.',
        detail: 'manifest unknown',
      },
    });
  });

  it('fails with a timeout when the engine stays silent', async () => {
    await startServer(() => {
      // Never answers.
    });

    await expect(clientWith(100).ping()).rejects.toMatchObject({
      error: { message: 'Docker did not respond in time.', detail: 'timeout' },
    });
  });

  it('fails with a bad-response error when the body is not JSON', async () => {
    await startServer((_request, response) => {
      response.writeHead(200);
      response.end('not json');
    });

    await expect(clientWith().version()).rejects.toMatchObject({
      error: { message: 'Docker returned an unexpected response.', detail: 'version' },
    });
  });
});

describe('DockerEngineClient without an engine', () => {
  it('reports the socket as not reachable when the socket file is missing', async () => {
    await expect(clientWith().ping()).rejects.toMatchObject({
      error: { code: 'INTERNAL', message: 'Docker is not reachable.', detail: 'ENOENT' },
    });
  });

  it('reports the socket as not reachable when nothing listens on it', async () => {
    writeFileSync(socketPath, '');

    await expect(clientWith().ping()).rejects.toMatchObject({
      error: { message: 'Docker is not reachable.', detail: 'ECONNREFUSED' },
    });
  });
});

describe('defaultDockerSocket', () => {
  it('uses the Linux socket when DOCKER_HOST is unset', () => {
    expect(defaultDockerSocket({}, 'linux')).toBe('/var/run/docker.sock');
  });

  it('uses the named pipe on Windows', () => {
    expect(defaultDockerSocket({}, 'win32')).toBe('//./pipe/docker_engine');
  });

  it('uses the path of a unix:// DOCKER_HOST', () => {
    expect(defaultDockerSocket({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }, 'linux')).toBe(
      '/run/user/1000/docker.sock',
    );
  });

  it('ignores DOCKER_HOST values that are not unix sockets', () => {
    expect(defaultDockerSocket({ DOCKER_HOST: 'tcp://10.0.0.5:2375' }, 'linux')).toBe(
      '/var/run/docker.sock',
    );
    expect(defaultDockerSocket({ DOCKER_HOST: 'unix://' }, 'linux')).toBe('/var/run/docker.sock');
  });
});
