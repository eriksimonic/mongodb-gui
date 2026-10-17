import type { ConnectionProfile } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { staleDockerProfiles } from './prune';

function profile(id: string, source: 'manual' | 'docker', containerId?: string): ConnectionProfile {
  return {
    id,
    name: id,
    uri: 'mongodb://localhost:27017',
    source,
    ...(containerId === undefined ? {} : { dockerContainerId: containerId }),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as ConnectionProfile;
}

const names = (items: ConnectionProfile[]): string[] => items.map((item) => item.id);

describe('staleDockerProfiles', () => {
  const docker = profile('d1', 'docker', 'c1');

  it('keeps a profile whose container is listed', () => {
    expect(staleDockerProfiles([docker], new Set(['c1']))).toEqual([]);
  });

  it('keeps a stopped container, which the full list still names', () => {
    expect(staleDockerProfiles([docker], new Set(['c1', 'c2']))).toEqual([]);
  });

  it('returns a profile whose container is absent', () => {
    expect(names(staleDockerProfiles([docker], new Set(['other'])))).toEqual(['d1']);
  });

  it('returns nothing when Docker could not be listed', () => {
    expect(staleDockerProfiles([docker], undefined)).toEqual([]);
  });

  it('never returns a manual profile', () => {
    expect(staleDockerProfiles([profile('m1', 'manual')], new Set())).toEqual([]);
    expect(staleDockerProfiles([profile('m2', 'docker')], new Set())).toEqual([]);
  });

  it('returns only the absent ones from a mix', () => {
    const profiles = [
      docker,
      profile('d2', 'docker', 'gone'),
      profile('m1', 'manual'),
      profile('d3', 'docker', 'gone2'),
    ];
    expect(names(staleDockerProfiles(profiles, new Set(['c1'])))).toEqual(['d2', 'd3']);
  });
});
