import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AppErrorException, appError, toDockerContainerSummary } from '@mongo-gui/core';
import {
  dialHost,
  discoverMongoContainers,
  dockerStatus,
  isMongoImage,
  networkAddress,
  toMongoContainer,
} from './discovery';
import {
  DockerEngineError,
  type ContainerListItem,
  type DockerEngineClient,
} from './engine-client';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'));
}

/** Returns a copy of an inspect fixture with some fields replaced. */
function inspectWith(base: unknown, patch: (json: Record<string, unknown>) => void): unknown {
  const copy = structuredClone(base) as Record<string, unknown>;
  patch(copy);
  return copy;
}

describe('isMongoImage', () => {
  it('accepts the MongoDB images the plan lists, with or without a tag or digest', () => {
    for (const image of [
      'mongo',
      'mongo:7',
      'docker.io/library/mongo:8.0.17',
      'mongo@sha256:abc',
      'mongodb/mongodb-community-server:7.0-ubi9',
      'bitnami/mongodb:6.0',
      'percona/percona-server-mongodb:5.0.15',
    ]) {
      expect(isMongoImage(image), image).toBe(true);
    }
  });

  it('rejects look-alike images', () => {
    for (const image of [
      'mongo-express:1.0',
      'ghcr.io/acme/mongo:7',
      'nginx:latest',
      'bitnami/redis',
    ]) {
      expect(isMongoImage(image), image).toBe(false);
    }
  });
});

describe('toMongoContainer', () => {
  it('maps a container with a published 27017 port and no credentials', () => {
    const container = toMongoContainer(fixture('inspect-mongo7-published.json'));

    expect(container).toMatchObject({
      name: 'flowbase-flow-editor-mongo1-1',
      image: 'mongo:7',
      state: 'running',
      publishedPort: { hostIp: '0.0.0.0', hostPort: 27017 },
      internalPort: 27017,
      networks: ['flowbase-flow-editor_default'],
      env: {},
    });
    expect(container?.envKeys).toContain('MONGO_VERSION');
  });

  it('maps a container that exposes 27017 without a published port', () => {
    const container = toMongoContainer(fixture('inspect-testcontainers-mongo-8.0.17.json'));

    expect(container).toMatchObject({
      image: 'mongo:8.0.17',
      state: 'running',
      internalPort: 27017,
      networks: ['bridge'],
    });
    expect(container?.publishedPort).toBeUndefined();
  });

  it('reads root credentials and the initial database from the MongoDB image variables', () => {
    const json = inspectWith(fixture('inspect-testcontainers-mongo-8.0.17.json'), (copy) => {
      const config = copy['Config'] as { Env: string[] };
      config.Env = [
        ...config.Env,
        'MONGO_INITDB_ROOT_USERNAME=root',
        'MONGO_INITDB_ROOT_PASSWORD=pa=ss',
        'MONGO_INITDB_DATABASE=shop',
      ];
    });
    const container = toMongoContainer(json);

    expect(container?.env).toEqual({ username: 'root', password: 'pa=ss', database: 'shop' });
    const summary = container === undefined ? undefined : toDockerContainerSummary(container);
    expect(summary).toMatchObject({
      env: { username: 'root', database: 'shop' },
      hasCredentials: true,
    });
    expect(JSON.stringify(summary)).not.toContain('pa=ss');
  });

  it('reads the bitnami variables when the official ones are missing', () => {
    const json = inspectWith(fixture('inspect-testcontainers-mongo-8.0.17.json'), (copy) => {
      const config = copy['Config'] as { Env: string[] };
      config.Env = [
        ...config.Env,
        'MONGODB_ROOT_USER=admin',
        'MONGODB_ROOT_PASSWORD=bitnami-secret',
      ];
    });

    expect(toMongoContainer(json)?.env).toEqual({ username: 'admin', password: 'bitnami-secret' });
  });

  it('prefers loopback over wildcard bindings', () => {
    const json = inspectWith(fixture('inspect-mongo7-published.json'), (copy) => {
      const network = copy['NetworkSettings'] as { Ports: Record<string, unknown> };
      network.Ports = {
        '27017/tcp': [
          { HostIp: '0.0.0.0', HostPort: '27018' },
          { HostIp: '127.0.0.1', HostPort: '27019' },
        ],
      };
    });

    expect(toMongoContainer(json)?.publishedPort).toEqual({ hostIp: '127.0.0.1', hostPort: 27019 });
  });

  it('treats a non-mongo image that exposes 27017 as a candidate', () => {
    const json = inspectWith(fixture('inspect-testcontainers-mongo-8.0.17.json'), (copy) => {
      copy['Config'] = { ...(copy['Config'] as object), Image: 'acme/custom-db:1' };
    });

    expect(toMongoContainer(json)?.image).toBe('acme/custom-db:1');
  });

  it('skips a container with no MongoDB image and no 27017 port', () => {
    const json = inspectWith(fixture('inspect-testcontainers-mongo-8.0.17.json'), (copy) => {
      copy['Config'] = { ...(copy['Config'] as object), Image: 'nginx:1', ExposedPorts: {} };
      copy['NetworkSettings'] = { Ports: {}, Networks: {} };
    });

    expect(toMongoContainer(json)).toBeUndefined();
  });

  it('skips forwarders this app started', () => {
    const json = inspectWith(fixture('inspect-testcontainers-mongo-8.0.17.json'), (copy) => {
      copy['Config'] = {
        ...(copy['Config'] as object),
        Labels: { 'mongo-gui.forwarder': 'abc' },
      };
    });

    expect(toMongoContainer(json)).toBeUndefined();
  });

  it('returns undefined for input that is not inspect JSON', () => {
    expect(toMongoContainer({ Id: 1 })).toBeUndefined();
    expect(toMongoContainer(null)).toBeUndefined();
  });

  it('maps unknown engine states to other', () => {
    const json = inspectWith(fixture('inspect-testcontainers-mongo-8.0.17.json'), (copy) => {
      copy['State'] = { Status: 'created' };
    });

    expect(toMongoContainer(json)?.state).toBe('other');
  });
});

describe('networkAddress and dialHost', () => {
  it('returns the address on a named network', () => {
    expect(networkAddress(fixture('inspect-testcontainers-mongo-8.0.17.json'), 'bridge')).toMatch(
      /^\d+\.\d+\.\d+\.\d+$/,
    );
    expect(
      networkAddress(fixture('inspect-testcontainers-mongo-8.0.17.json'), 'missing'),
    ).toBeUndefined();
  });

  it('dials loopback for wildcard bindings and the bound address otherwise', () => {
    expect(dialHost({ hostIp: '0.0.0.0', hostPort: 1 })).toBe('127.0.0.1');
    expect(dialHost({ hostIp: '::', hostPort: 1 })).toBe('127.0.0.1');
    expect(dialHost({ hostIp: '192.168.1.5', hostPort: 1 })).toBe('192.168.1.5');
  });
});

function listItem(overrides: Partial<ContainerListItem>): ContainerListItem {
  return {
    id: 'a'.repeat(64),
    names: ['/x'],
    image: 'nginx:1',
    state: 'running',
    imageId: 'sha256:socat',
    labels: {},
    ports: [],
    ...overrides,
  };
}

/** A client that answers the list and inspect calls from a table. Other methods fail the test. */
function fakeClient(options: {
  list: ContainerListItem[];
  inspect: Record<string, unknown>;
  version?: () => Promise<{ version: string; apiVersion: string }>;
}): DockerEngineClient {
  const unexpected = (): never => {
    throw new Error('not expected in discovery');
  };
  return {
    ping: unexpected,
    version: options.version ?? (async () => ({ version: '27.3.1', apiVersion: '1.47' })),
    listContainers: async () => options.list,
    listContainersByLabel: unexpected,
    inspectContainer: async (id) => {
      const json = options.inspect[id];
      if (json === undefined) {
        throw new DockerEngineError('Docker returned HTTP 404.', undefined, 404);
      }
      return json;
    },
    createContainer: unexpected,
    startContainer: unexpected,
    removeContainer: unexpected,
    hasImage: unexpected,
    imageId: unexpected,
    pullImage: unexpected,
  };
}

describe('discoverMongoContainers', () => {
  it('returns mongo containers sorted by name and skips the rest', async () => {
    const mongo7 = fixture('inspect-mongo7-published.json') as { Id: string };
    const testcontainers = fixture('inspect-testcontainers-mongo-8.0.17.json') as { Id: string };
    const client = fakeClient({
      list: [
        listItem({ id: mongo7.Id, image: 'mongo:7', names: ['/flowbase-flow-editor-mongo1-1'] }),
        listItem({ id: testcontainers.Id, image: 'mongo:8.0.17', ports: [27017] }),
        listItem({ id: 'web', image: 'nginx:1', ports: [80] }),
        listItem({
          id: 'forwarder',
          image: 'alpine/socat',
          labels: { 'mongo-gui.forwarder': 'x' },
        }),
      ],
      inspect: { [mongo7.Id]: mongo7, [testcontainers.Id]: testcontainers },
    });

    const found = await discoverMongoContainers(client);

    expect(found.map((container) => container.name)).toEqual([
      'flowbase-flow-editor-mongo1-1',
      'inspiring_goodall',
    ]);
  });

  it('skips a container that disappears between list and inspect', async () => {
    const client = fakeClient({
      list: [listItem({ id: 'gone', image: 'mongo:7' })],
      inspect: {},
    });

    expect(await discoverMongoContainers(client)).toEqual([]);
  });

  it('rethrows engine failures other than a missing container', async () => {
    const client: DockerEngineClient = {
      ...fakeClient({ list: [], inspect: {} }),
      listContainers: async () => {
        throw new DockerEngineError('Docker is not reachable.', 'ENOENT');
      },
    };

    await expect(discoverMongoContainers(client)).rejects.toBeInstanceOf(AppErrorException);
  });
});

const SOCKET = '/var/run/docker.sock';

describe('dockerStatus', () => {
  it('reports the engine version when the engine answers', async () => {
    expect(await dockerStatus(fakeClient({ list: [], inspect: {} }), SOCKET)).toEqual({
      available: true,
      engineVersion: '27.3.1',
    });
  });

  it('reports the reason when the engine is unreachable', async () => {
    const client = fakeClient({
      list: [],
      inspect: {},
      version: async () => {
        throw new DockerEngineError('Docker is not reachable.', 'ENOENT');
      },
    });

    expect(await dockerStatus(client, SOCKET)).toEqual({
      available: false,
      reason: 'Docker is not reachable at /var/run/docker.sock (ENOENT).',
    });
  });

  it('uses a generic reason for errors that are not engine errors', async () => {
    const client = fakeClient({
      list: [],
      inspect: {},
      version: async () => {
        throw new AppErrorException(appError('INTERNAL', 'other'));
      },
    });

    expect(await dockerStatus(client, SOCKET)).toEqual({
      available: false,
      reason: 'Docker is not available at /var/run/docker.sock.',
    });
  });

  it('explains a permission error and suggests the docker group', async () => {
    const client = fakeClient({
      list: [],
      inspect: {},
      version: async () => {
        throw new DockerEngineError('Docker is not reachable.', 'EACCES');
      },
    });

    expect(await dockerStatus(client, SOCKET)).toEqual({
      available: false,
      reason:
        'Permission denied on /var/run/docker.sock. Add your user to the docker group, then sign in again.',
    });
  });
});
