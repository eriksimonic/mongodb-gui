import { describe, expect, it } from 'vitest';
import {
  DockerContainerIdSchema,
  DockerMongoContainerSummarySchema,
  toDockerContainerSummary,
  type DockerMongoContainer,
} from './types';

const container: DockerMongoContainer = {
  id: 'f0e1d2c3b4a5',
  name: 'shop-db',
  image: 'mongo:7',
  state: 'running',
  internalPort: 27017,
  networks: ['bridge'],
  env: { username: 'root', password: 'do-not-leak', database: 'shop' },
  envKeys: ['MONGO_INITDB_ROOT_PASSWORD', 'MONGO_INITDB_ROOT_USERNAME'],
};

describe('toDockerContainerSummary', () => {
  it('replaces the password with hasCredentials and keeps the username and database', () => {
    const summary = toDockerContainerSummary(container);

    expect(summary.env).toEqual({ username: 'root', database: 'shop' });
    expect(summary.hasCredentials).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('do-not-leak');
  });

  it('reports no credentials without a username and password pair', () => {
    const summary = toDockerContainerSummary({ ...container, env: { username: 'root' } });

    expect(summary.hasCredentials).toBe(false);
    expect(summary.env).toEqual({ username: 'root' });
  });

  it('passes its own summary schema, which strips a password that slips through', () => {
    const summary = toDockerContainerSummary(container);
    const parsed = DockerMongoContainerSummarySchema.parse({
      ...summary,
      env: { ...summary.env, password: 'do-not-leak' },
    });

    expect(JSON.stringify(parsed)).not.toContain('do-not-leak');
  });
});

describe('DockerContainerIdSchema', () => {
  it('accepts hex ids and container names', () => {
    expect(DockerContainerIdSchema.safeParse('7aadc21db136').success).toBe(true);
    expect(DockerContainerIdSchema.safeParse('flowbase-mongo_1').success).toBe(true);
  });

  it('rejects anything that could change the URL path', () => {
    for (const value of ['', '../containers', 'a/b', 'a?x=1', '-leading', 'a b']) {
      expect(DockerContainerIdSchema.safeParse(value).success, value).toBe(false);
    }
  });
});
