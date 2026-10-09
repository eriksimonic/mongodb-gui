import { describe, expect, it } from 'vitest';
import { AppErrorException } from '../domain/errors';
import {
  normaliseReplicaSetConfig,
  normaliseReplicaSetStatus,
  memberLagSeconds,
} from './normalise';
import { ReplicaSetStatusSchema } from './types';

const serialise = (value: unknown): string => JSON.stringify(value);

const PRIMARY_OPTIME = new Date('2026-10-09T10:00:10.000Z');
const SECONDARY_OPTIME = new Date('2026-10-09T10:00:07.500Z');

function rawConfig(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      _id: 'rs0',
      version: 4,
      term: 2,
      protocolVersion: 1n,
      settings: { heartbeatIntervalMillis: 2000 },
      members: [
        { _id: 0, host: 'mongo0:27017', priority: 2, votes: 1, tags: { dc: 'east' } },
        { _id: 1, host: 'mongo1:27017', priority: 1, votes: 1 },
        { _id: 2, host: 'mongo2:27017', priority: 0, votes: 0, hidden: true, slaveDelay: 30 },
      ],
      ...overrides,
    },
    ok: 1,
  };
}

function rawMember(overrides: Record<string, unknown>) {
  return {
    _id: 0,
    name: 'mongo0:27017',
    health: 1,
    state: 1,
    stateStr: 'PRIMARY',
    uptime: 120,
    optimeDate: PRIMARY_OPTIME,
    self: true,
    ...overrides,
  };
}

function rawStatus(members: unknown[]) {
  return { set: 'rs0', myState: 1, term: 2, members, ok: 1 };
}

describe('normaliseReplicaSetConfig', () => {
  it('maps each member and keeps the settings', () => {
    const config = normaliseReplicaSetConfig(rawConfig(), serialise);
    expect(config.id).toBe('rs0');
    expect(config.version).toBe(4);
    expect(config.term).toBe(2);
    expect(config.protocolVersion).toBe(1);
    expect(config.settingsEjson).toBe('{"heartbeatIntervalMillis":2000}');
    expect(config.members).toEqual([
      {
        id: 0,
        host: 'mongo0:27017',
        priority: 2,
        votes: 1,
        hidden: false,
        arbiterOnly: false,
        buildIndexes: true,
        secondaryDelaySecs: 0,
        tags: { dc: 'east' },
        extraEjson: '{}',
      },
      {
        id: 1,
        host: 'mongo1:27017',
        priority: 1,
        votes: 1,
        hidden: false,
        arbiterOnly: false,
        buildIndexes: true,
        secondaryDelaySecs: 0,
        tags: {},
        extraEjson: '{}',
      },
      {
        id: 2,
        host: 'mongo2:27017',
        priority: 0,
        votes: 0,
        hidden: true,
        arbiterOnly: false,
        buildIndexes: true,
        secondaryDelaySecs: 30,
        tags: {},
        extraEjson: '{}',
      },
    ]);
  });

  it('prefers secondaryDelaySecs over slaveDelay when both are present', () => {
    const reply = rawConfig({
      members: [{ _id: 0, host: 'a:1', secondaryDelaySecs: 5, slaveDelay: 9 }],
    });
    expect(normaliseReplicaSetConfig(reply, serialise).members[0]?.secondaryDelaySecs).toBe(5);
  });

  it('drops tag values that are not strings', () => {
    const reply = rawConfig({
      members: [{ _id: 0, host: 'a:1', tags: { dc: 'east', rack: 3 } }],
    });
    expect(normaliseReplicaSetConfig(reply, serialise).members[0]?.tags).toEqual({ dc: 'east' });
  });

  it('serialises the settings and the unmodelled fields with the given serialiser', () => {
    const config = normaliseReplicaSetConfig(rawConfig({ configsvr: true }), serialise);
    expect(config.settingsEjson).toBe('{"heartbeatIntervalMillis":2000}');
    expect(config.extraEjson).toBe('{"configsvr":true}');
  });

  it('keeps member fields the planner does not model as EJSON', () => {
    const reply = rawConfig({
      members: [{ _id: 0, host: 'a:1', horizons: { external: 'a.example:27017' } }],
    });
    const config = normaliseReplicaSetConfig(reply, serialise);
    expect(config.members[0]?.extraEjson).toBe('{"horizons":{"external":"a.example:27017"}}');
  });

  it('defaults the settings to an empty document when the config has none', () => {
    const reply = rawConfig({ settings: undefined });
    expect(normaliseReplicaSetConfig(reply, serialise).settingsEjson).toBe('{}');
  });

  it('throws a COMMAND_FAILED error for a reply without a config', () => {
    expect(() => normaliseReplicaSetConfig({ ok: 1 }, serialise)).toThrow(AppErrorException);
    try {
      normaliseReplicaSetConfig({ ok: 1 }, serialise);
    } catch (error) {
      expect(error).toBeInstanceOf(AppErrorException);
      expect((error as AppErrorException).error.code).toBe('COMMAND_FAILED');
    }
  });
});

describe('normaliseReplicaSetStatus', () => {
  it('merges configuration fields into each member and finds the primary', () => {
    const status = normaliseReplicaSetStatus({
      status: rawStatus([
        rawMember({}),
        rawMember({
          _id: 1,
          name: 'mongo1:27017',
          state: 2,
          stateStr: 'SECONDARY',
          self: false,
          optimeDate: SECONDARY_OPTIME,
          syncSourceHost: 'mongo0:27017',
          electionDate: new Date('2026-10-09T09:00:00.000Z'),
          configVersion: 4,
          lastHeartbeatMessage: '',
        }),
      ]),
      config: rawConfig(),
      serialise,
    });
    expect(ReplicaSetStatusSchema.safeParse(status).success).toBe(true);
    expect(status.setName).toBe('rs0');
    expect(status.myState).toBe(1);
    expect(status.term).toBe(2);
    expect(status.primary).toBe('mongo0:27017');
    const [primary, secondary] = status.members;
    expect(primary).toMatchObject({
      id: 0,
      name: 'mongo0:27017',
      state: 'PRIMARY',
      stateCode: 1,
      health: 1,
      uptimeSeconds: 120,
      self: true,
      priority: 2,
      votes: 1,
      tags: { dc: 'east' },
      optimeDate: '2026-10-09T10:00:10.000Z',
    });
    expect(primary).not.toHaveProperty('lagSeconds');
    expect(primary).not.toHaveProperty('syncSourceHost');
    expect(secondary).toMatchObject({
      id: 1,
      state: 'SECONDARY',
      lagSeconds: 2.5,
      syncSourceHost: 'mongo0:27017',
      electionDate: '2026-10-09T09:00:00.000Z',
      configVersion: 4,
      priority: 1,
      votes: 1,
    });
    expect(secondary).not.toHaveProperty('lastHeartbeatMessage');
  });

  it('reads the member fields from the config and not from the status', () => {
    const status = normaliseReplicaSetStatus({
      status: rawStatus([
        rawMember({ _id: 2, name: 'mongo2:27017', state: 2, stateStr: 'SECONDARY', self: false }),
      ]),
      config: rawConfig(),
      serialise,
    });
    expect(status.members[0]).toMatchObject({
      id: 2,
      priority: 0,
      votes: 0,
      hidden: true,
      secondaryDelaySecs: 30,
    });
  });

  it('gives a member missing from the config no votes and no priority', () => {
    const status = normaliseReplicaSetStatus({
      status: rawStatus([
        rawMember({ _id: 9, name: 'ghost:27017', state: 2, stateStr: 'SECONDARY', self: false }),
      ]),
      config: rawConfig(),
      serialise,
    });
    expect(status.members[0]).toMatchObject({ id: 9, priority: 0, votes: 0, buildIndexes: true });
  });

  it('omits lag for an unhealthy secondary and for a member without an optime', () => {
    const status = normaliseReplicaSetStatus({
      status: rawStatus([
        rawMember({}),
        rawMember({
          _id: 1,
          name: 'mongo1:27017',
          state: 8,
          stateStr: 'DOWN',
          health: 0,
          self: false,
          optimeDate: SECONDARY_OPTIME,
        }),
        rawMember({
          _id: 2,
          name: 'mongo2:27017',
          state: 2,
          stateStr: 'SECONDARY',
          self: false,
          optimeDate: new Date(0),
        }),
      ]),
      config: rawConfig(),
      serialise,
    });
    expect(status.members[1]).not.toHaveProperty('lagSeconds');
    expect(status.members[2]).not.toHaveProperty('lagSeconds');
  });

  it('omits the optime of a member that reports epoch zero', () => {
    const status = normaliseReplicaSetStatus({
      status: rawStatus([
        rawMember({
          _id: 2,
          name: 'mongo2:27017',
          state: 2,
          stateStr: 'SECONDARY',
          self: false,
          optimeDate: new Date(0),
        }),
      ]),
      config: rawConfig(),
      serialise,
    });
    expect(status.members[0]).not.toHaveProperty('optimeDate');
  });

  it('uses the state number when stateStr is missing', () => {
    const status = normaliseReplicaSetStatus({
      status: rawStatus([rawMember({ stateStr: undefined, state: 1 })]),
      config: rawConfig(),
      serialise,
    });
    expect(status.members[0]?.state).toBe('1');
  });

  it('builds the oplog window and sizes from the first and last entries', () => {
    const status = normaliseReplicaSetStatus({
      status: rawStatus([rawMember({})]),
      config: rawConfig(),
      serialise,
      oplogFirst: { ts: { t: 1_700_000_000, i: 1 } },
      oplogLast: { ts: { t: 1_700_003_600, i: 7 } },
      oplogStats: { maxSize: 1024 * 1024 * 512, size: 1024 * 1024 * 40 },
    });
    expect(status.oplog).toEqual({
      firstTs: new Date(1_700_000_000_000).toISOString(),
      lastTs: new Date(1_700_003_600_000).toISOString(),
      windowSeconds: 3600,
      sizeMb: 512,
      usedMb: 40,
    });
  });

  it('reads an unsigned high word when the seconds field is absent', () => {
    const status = normaliseReplicaSetStatus({
      status: rawStatus([rawMember({})]),
      config: rawConfig(),
      serialise,
      oplogFirst: { ts: { high: 0xb0000000 | 0, low: 1 } },
      oplogLast: { ts: { high: 0xb0000000 | 0, low: 9 } },
    });
    expect(status.oplog?.windowSeconds).toBe(0);
    expect(status.oplog?.firstTs).toBe(new Date(0xb0000000 * 1000).toISOString());
  });

  it('omits the oplog when the window is inverted or an edge is missing', () => {
    const inverted = normaliseReplicaSetStatus({
      status: rawStatus([rawMember({})]),
      config: rawConfig(),
      serialise,
      oplogFirst: { ts: { t: 200 } },
      oplogLast: { ts: { t: 100 } },
    });
    const missing = normaliseReplicaSetStatus({
      status: rawStatus([rawMember({})]),
      config: rawConfig(),
      serialise,
      oplogFirst: { ts: { t: 100 } },
    });
    expect(inverted.oplog).toBeUndefined();
    expect(missing.oplog).toBeUndefined();
  });

  it('passes the election metrics through as opaque data', () => {
    const metrics = { lastElectionReason: 'electionTimeout' };
    const status = normaliseReplicaSetStatus({
      status: { ...rawStatus([rawMember({})]), electionCandidateMetrics: metrics },
      config: rawConfig(),
      serialise,
    });
    expect(status.electionCandidateMetrics).toEqual(metrics);
  });

  it('leaves primary undefined when no member is primary', () => {
    const status = normaliseReplicaSetStatus({
      status: rawStatus([rawMember({ state: 2, stateStr: 'SECONDARY', self: true })]),
      config: rawConfig(),
      serialise,
    });
    expect(status.primary).toBeUndefined();
  });
});

describe('memberLagSeconds', () => {
  it('returns the distance from the primary optime for a healthy secondary', () => {
    expect(memberLagSeconds({ health: 1, state: 'SECONDARY', optimeMs: 1000 }, 4000)).toBe(3);
  });

  it('clamps a secondary that is ahead of the primary to zero', () => {
    expect(memberLagSeconds({ health: 1, state: 'SECONDARY', optimeMs: 5000 }, 4000)).toBe(0);
  });

  it('returns undefined without a primary optime, for a primary, or for an unhealthy member', () => {
    expect(memberLagSeconds({ health: 1, state: 'SECONDARY', optimeMs: 1000 }, undefined)).toBe(
      undefined,
    );
    expect(memberLagSeconds({ health: 1, state: 'PRIMARY', optimeMs: 1000 }, 4000)).toBe(undefined);
    expect(memberLagSeconds({ health: 0, state: 'SECONDARY', optimeMs: 1000 }, 4000)).toBe(
      undefined,
    );
    expect(memberLagSeconds({ health: 1, state: 'SECONDARY', optimeMs: 0 }, 4000)).toBe(undefined);
  });
});
