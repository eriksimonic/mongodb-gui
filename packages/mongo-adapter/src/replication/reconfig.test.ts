import { describe, expect, it } from 'vitest';
import {
  ReconfigPlanSchema,
  ReplicaSetConfigSchema,
  type ReconfigChange,
  type ReplicaSetConfig,
  type ReplicaSetMemberConfig,
  type ReplicaSetStatus,
} from '@mongo-gui/core';
import { planReconfig } from './reconfig';

type MemberOverrides = Partial<Omit<ReplicaSetMemberConfig, 'id'>>;

function voter(id: number, overrides: MemberOverrides = {}): ReplicaSetMemberConfig {
  return {
    id,
    host: `mongo${id}:27017`,
    priority: 1,
    votes: 1,
    hidden: false,
    arbiterOnly: false,
    buildIndexes: true,
    secondaryDelaySecs: 0,
    tags: {},
    ...overrides,
  };
}

function configOf(members: ReplicaSetMemberConfig[], version = 3): ReplicaSetConfig {
  return { id: 'rs0', version, members, settingsEjson: '{"heartbeatIntervalMillis":2000}' };
}

interface StateOverride {
  readonly state: string;
  readonly health: number;
}

// The first member is the primary unless an override says otherwise. An override with health 0 is
// an unreachable member.
function statusFor(
  members: ReplicaSetMemberConfig[],
  overrides: Partial<Record<number, StateOverride>> = {},
): ReplicaSetStatus {
  const entries = members.map((member, index) => {
    const override = overrides[member.id];
    const state = override?.state ?? (index === 0 ? 'PRIMARY' : 'SECONDARY');
    return {
      id: member.id,
      name: member.host,
      state,
      stateCode: state === 'PRIMARY' ? 1 : 2,
      health: override?.health ?? 1,
      self: index === 0,
      priority: member.priority,
      votes: member.votes,
      hidden: member.hidden,
      arbiterOnly: member.arbiterOnly,
      buildIndexes: member.buildIndexes,
      secondaryDelaySecs: member.secondaryDelaySecs,
      tags: member.tags,
    };
  });
  const primary = entries.find((entry) => entry.state === 'PRIMARY');
  return {
    setName: 'rs0',
    myState: 1,
    members: entries,
    ...(primary === undefined ? {} : { primary: primary.name }),
  };
}

const UNREACHABLE: StateOverride = { state: '(not reachable/healthy)', health: 0 };
const threeVoters = [voter(0), voter(1), voter(2)];
const healthyThree = statusFor(threeVoters);

type AddInput = Extract<ReconfigChange, { kind: 'add' }>['member'];

function add(member: AddInput): ReconfigChange {
  return { kind: 'add', member };
}

function planWith(config: ReplicaSetConfig, change: ReconfigChange, status: ReplicaSetStatus) {
  return planReconfig(config, change, status);
}

describe('planReconfig: shared behaviour', () => {
  it('bumps the version and keeps the set name, settings and other config fields', () => {
    const config = { ...configOf(threeVoters), term: 7, protocolVersion: 1 };
    const plan = planWith(config, { kind: 'remove', memberId: 2 }, healthyThree);
    expect(plan.refused).toBeUndefined();
    expect(plan.next.version).toBe(4);
    expect(plan.next.id).toBe('rs0');
    expect(plan.next.term).toBe(7);
    expect(plan.next.protocolVersion).toBe(1);
    expect(plan.next.settingsEjson).toBe('{"heartbeatIntervalMillis":2000}');
    expect(plan.changes).toContain('Raise the configuration version from 3 to 4.');
  });

  it('returns the input configuration as the current side of the plan', () => {
    const config = configOf(threeVoters);
    const plan = planWith(config, { kind: 'remove', memberId: 2 }, healthyThree);
    expect(plan.current).toBe(config);
  });

  it('does not mutate the input configuration or the status', () => {
    const config = configOf(threeVoters);
    const status = statusFor(threeVoters);
    const configSnapshot = structuredClone(config);
    const statusSnapshot = structuredClone(status);
    planWith(config, { kind: 'remove', memberId: 2 }, status);
    planWith(config, { kind: 'update', memberId: 1, patch: { priority: 0, votes: 0 } }, status);
    planWith(config, { kind: 'add', member: { host: 'mongo3:27017' } }, status);
    expect(config).toEqual(configSnapshot);
    expect(status).toEqual(statusSnapshot);
  });

  it('keeps the members sorted by id in the next configuration', () => {
    const config = configOf([voter(2), voter(0), voter(5)]);
    const plan = planWith(
      config,
      { kind: 'add', member: { host: 'mongo1:27017' } },
      statusFor([voter(0), voter(2), voter(5)]),
    );
    expect(plan.next.members.map((member) => member.id)).toEqual([0, 1, 2, 5]);
  });

  it('produces a plan that matches the plan schema', () => {
    const plan = planWith(configOf(threeVoters), { kind: 'remove', memberId: 2 }, healthyThree);
    expect(ReconfigPlanSchema.safeParse(plan).success).toBe(true);
    expect(ReplicaSetConfigSchema.safeParse(plan.next).success).toBe(true);
  });

  it('refuses a change that leaves the configuration as it is', () => {
    const plan = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 1, patch: { priority: 1 } },
      healthyThree,
    );
    expect(plan.refused).toBe('The change leaves the configuration as it is.');
    expect(plan.changes).toEqual(['Raise the configuration version from 3 to 4.']);
  });

  it('joins every refusal into one reason', () => {
    const plan = planWith(
      configOf([voter(0)]),
      { kind: 'update', memberId: 0, patch: { votes: 0, priority: 1 } },
      statusFor([voter(0)]),
    );
    expect(plan.refused).toBe('mongo0:27017 has no votes, so its priority must be 0.');
  });
});

describe('planReconfig: add', () => {
  it('adds a voting member with priority 1 under the next free id', () => {
    const plan = planWith(configOf(threeVoters), add({ host: 'mongo3:27017' }), healthyThree);
    expect(plan.refused).toBeUndefined();
    expect(plan.next.members.find((member) => member.id === 3)).toEqual({
      id: 3,
      host: 'mongo3:27017',
      priority: 1,
      votes: 1,
      hidden: false,
      arbiterOnly: false,
      buildIndexes: true,
      secondaryDelaySecs: 0,
      tags: {},
    });
    expect(plan.changes[0]).toBe(
      'Add mongo3:27017 as member 3: priority 1, votes 1, hidden false, arbiter false, delay 0 seconds.',
    );
    expect(plan.warnings).toEqual([]);
  });

  it('reuses the smallest free id left by an earlier removal', () => {
    const members = [voter(0), voter(2)];
    const plan = planWith(configOf(members), add({ host: 'mongo1:27017' }), statusFor(members));
    expect(plan.next.members.map((member) => member.id)).toEqual([0, 1, 2]);
  });

  it('applies the explicit member options', () => {
    const plan = planWith(
      configOf(threeVoters),
      add({
        host: 'mongo3:27017',
        priority: 2,
        votes: 1,
        buildIndexes: false,
        tags: { dc: 'west' },
      }),
      healthyThree,
    );
    expect(plan.next.members.find((member) => member.id === 3)).toMatchObject({
      priority: 2,
      buildIndexes: false,
      tags: { dc: 'west' },
    });
  });

  it('refuses a host that is already a member', () => {
    const plan = planWith(configOf(threeVoters), add({ host: 'mongo1:27017' }), healthyThree);
    expect(plan.refused).toBe('mongo1:27017 is already a member of the set.');
  });

  it('gives a votes 0 member priority 0 by default and refuses priority above 0', () => {
    const defaulted = planWith(
      configOf(threeVoters),
      add({ host: 'mongo3:27017', votes: 0 }),
      healthyThree,
    );
    expect(defaulted.refused).toBeUndefined();
    expect(defaulted.next.members.find((member) => member.id === 3)?.priority).toBe(0);

    const explicit = planWith(
      configOf(threeVoters),
      add({ host: 'mongo3:27017', votes: 0, priority: 1 }),
      healthyThree,
    );
    expect(explicit.refused).toBe('mongo3:27017 has no votes, so its priority must be 0.');
  });

  it('gives a hidden member priority 0 without a warning by default', () => {
    const plan = planWith(
      configOf(threeVoters),
      add({ host: 'mongo3:27017', hidden: true, votes: 0 }),
      healthyThree,
    );
    expect(plan.refused).toBeUndefined();
    expect(plan.next.members.find((member) => member.id === 3)?.priority).toBe(0);
    expect(plan.warnings).toEqual([]);
  });

  it('corrects an explicit hidden priority to 0 with a warning', () => {
    const plan = planWith(
      configOf(threeVoters),
      add({ host: 'mongo3:27017', hidden: true, priority: 3, votes: 0 }),
      healthyThree,
    );
    expect(plan.refused).toBeUndefined();
    expect(plan.next.members.find((member) => member.id === 3)).toMatchObject({
      hidden: true,
      priority: 0,
    });
    expect(plan.warnings).toEqual([
      'mongo3:27017 is hidden, so its priority is set to 0 instead of 3.',
    ]);
  });

  it('gives a delayed member priority 0 by default and warns about the delay', () => {
    const plan = planWith(
      configOf(threeVoters),
      add({ host: 'mongo3:27017', secondaryDelaySecs: 3600, votes: 0 }),
      healthyThree,
    );
    expect(plan.refused).toBeUndefined();
    expect(plan.next.members.find((member) => member.id === 3)).toMatchObject({
      priority: 0,
      secondaryDelaySecs: 3600,
    });
    expect(plan.warnings).toEqual([
      'mongo3:27017 is delayed by 3600 seconds. It never becomes primary, and its data lags by that delay.',
    ]);
  });

  it('refuses a delayed member with an explicit priority above 0', () => {
    const plan = planWith(
      configOf(threeVoters),
      add({ host: 'mongo3:27017', secondaryDelaySecs: 60, priority: 1 }),
      healthyThree,
    );
    expect(plan.refused).toBe('mongo3:27017 is delayed, so its priority must be 0.');
  });

  it('gives an arbiter priority 0 by default and refuses an arbiter with priority above 0', () => {
    const defaulted = planWith(
      configOf(threeVoters),
      add({ host: 'arbiter:27017', arbiterOnly: true }),
      healthyThree,
    );
    expect(defaulted.refused).toBeUndefined();
    expect(defaulted.next.members.find((member) => member.id === 3)).toMatchObject({
      arbiterOnly: true,
      priority: 0,
      votes: 1,
    });

    const explicit = planWith(
      configOf(threeVoters),
      add({ host: 'arbiter:27017', arbiterOnly: true, priority: 1 }),
      healthyThree,
    );
    expect(explicit.refused).toBe('arbiter:27017 is an arbiter, so its priority must be 0.');
  });

  it('refuses an arbiter that is hidden or delayed', () => {
    const hidden = planWith(
      configOf(threeVoters),
      add({ host: 'arbiter:27017', arbiterOnly: true, hidden: true }),
      healthyThree,
    );
    expect(hidden.refused).toBe('arbiter:27017 is an arbiter, and an arbiter cannot be hidden.');

    const delayed = planWith(
      configOf(threeVoters),
      add({ host: 'arbiter:27017', arbiterOnly: true, secondaryDelaySecs: 30 }),
      healthyThree,
    );
    expect(delayed.refused).toBe('arbiter:27017 is an arbiter, and an arbiter cannot be delayed.');
  });

  it('refuses votes outside 0 and 1', () => {
    const plan = planWith(
      configOf(threeVoters),
      add({ host: 'mongo3:27017', votes: 2 }),
      healthyThree,
    );
    expect(plan.refused).toBe('mongo3:27017 has 2 votes. A member has 0 or 1 votes.');
  });

  it('refuses a priority outside 0 to 1000', () => {
    const plan = planWith(
      configOf(threeVoters),
      add({ host: 'mongo3:27017', priority: 1001 }),
      healthyThree,
    );
    expect(plan.refused).toBe('mongo3:27017 has priority 1001. Priority must be from 0 to 1000.');
  });

  it('refuses a negative or fractional delay', () => {
    const negative = planWith(
      configOf(threeVoters),
      add({ host: 'mongo3:27017', secondaryDelaySecs: -5, votes: 0 }),
      healthyThree,
    );
    expect(negative.refused).toContain('The delay must be a whole number of seconds from 0.');

    const fractional = planWith(
      configOf(threeVoters),
      add({ host: 'mongo3:27017', secondaryDelaySecs: 1.5, votes: 0 }),
      healthyThree,
    );
    expect(fractional.refused).toContain('The delay must be a whole number of seconds from 0.');
  });

  it('refuses an eighth voting member', () => {
    const members = Array.from({ length: 7 }, (_, id) => voter(id));
    const plan = planWith(configOf(members), add({ host: 'mongo7:27017' }), statusFor(members));
    expect(plan.refused).toBe(
      'A replica set has at most 7 voting members, and this change would make 8.',
    );
  });

  it('accepts a non-voting member when seven members already vote', () => {
    const members = Array.from({ length: 7 }, (_, id) => voter(id));
    const plan = planWith(
      configOf(members),
      add({ host: 'mongo7:27017', votes: 0 }),
      statusFor(members),
    );
    expect(plan.refused).toBeUndefined();
  });

  it('refuses a 51st member', () => {
    const members = Array.from({ length: 50 }, (_, id) =>
      voter(id, { votes: id < 7 ? 1 : 0, priority: 0 }),
    );
    const plan = planWith(
      configOf(members),
      add({ host: 'mongo50:27017', votes: 0 }),
      statusFor(members),
    );
    expect(plan.refused).toBe(
      'A replica set has at most 50 members, and this change would make 51.',
    );
  });

  it('refuses a voting member when a voter is unreachable and the new majority is out of reach', () => {
    const status = statusFor(threeVoters, { 2: UNREACHABLE });
    const plan = planWith(configOf(threeVoters), add({ host: 'mongo3:27017' }), status);
    expect(plan.refused).toBe(
      'Only 2 of 4 voting members would be reachable, and a majority needs 3. This change would leave the set without a majority.',
    );
  });

  it('accepts a non-voting member while a voter is unreachable', () => {
    const status = statusFor(threeVoters, { 2: UNREACHABLE });
    const plan = planWith(configOf(threeVoters), add({ host: 'mongo3:27017', votes: 0 }), status);
    expect(plan.refused).toBeUndefined();
  });

  it('does not count the added member as reachable', () => {
    // Two of three voters are healthy, so a new voter gives four voters and needs three reachable.
    const status = statusFor(threeVoters, { 1: UNREACHABLE });
    const plan = planWith(configOf(threeVoters), add({ host: 'mongo3:27017' }), status);
    expect(plan.refused).toContain('Only 2 of 4 voting members');
  });
});

describe('planReconfig: remove', () => {
  it('removes a healthy secondary and warns that a voter is gone', () => {
    const plan = planWith(configOf(threeVoters), { kind: 'remove', memberId: 2 }, healthyThree);
    expect(plan.refused).toBeUndefined();
    expect(plan.changes[0]).toBe('Remove mongo2:27017 (member 2).');
    expect(plan.next.members.map((member) => member.id)).toEqual([0, 1]);
    expect(plan.warnings).toEqual([
      'The set has 2 voting members, down from 3. It tolerates 0 failed voting members, down from 1.',
    ]);
  });

  it('removes a non-voting member without a fault tolerance warning', () => {
    const members = [voter(0), voter(1), voter(2, { priority: 0, votes: 0 })];
    const plan = planWith(configOf(members), { kind: 'remove', memberId: 2 }, statusFor(members));
    expect(plan.refused).toBeUndefined();
    expect(plan.warnings).toEqual([]);
  });

  it('refuses the primary and names the step-down', () => {
    const plan = planWith(configOf(threeVoters), { kind: 'remove', memberId: 0 }, healthyThree);
    expect(plan.refused).toBe('mongo0:27017 is the primary. Step it down before removing it.');
    expect(plan.next.members).toHaveLength(3);
  });

  it('identifies the primary from the status primary field as well as the member state', () => {
    const status: ReplicaSetStatus = {
      ...healthyThree,
      members: healthyThree.members.map((member) => ({ ...member, state: 'SECONDARY' })),
      primary: 'mongo0:27017',
    };
    const plan = planWith(configOf(threeVoters), { kind: 'remove', memberId: 0 }, status);
    expect(plan.refused).toContain('is the primary');
  });

  it('refuses an unknown member id', () => {
    const plan = planWith(configOf(threeVoters), { kind: 'remove', memberId: 9 }, healthyThree);
    expect(plan.refused).toBe('No member has id 9.');
  });

  it('refuses the only member of the set', () => {
    const members = [voter(0, { priority: 1 })];
    const status = statusFor(members, { 0: { state: 'SECONDARY', health: 1 } });
    const plan = planWith(configOf(members), { kind: 'remove', memberId: 0 }, status);
    expect(plan.refused).toBe('The only member of the set cannot be removed.');
  });

  it('refuses a removal that leaves the voters without a reachable majority', () => {
    const status = statusFor(threeVoters, { 2: UNREACHABLE });
    const plan = planWith(configOf(threeVoters), { kind: 'remove', memberId: 1 }, status);
    expect(plan.refused).toBe(
      'Only 1 of 2 voting members would be reachable, and a majority needs 2. This change would leave the set without a majority.',
    );
  });

  it('allows removing the unreachable voter when the rest keep a majority', () => {
    const status = statusFor(threeVoters, { 2: UNREACHABLE });
    const plan = planWith(configOf(threeVoters), { kind: 'remove', memberId: 2 }, status);
    expect(plan.refused).toBeUndefined();
  });

  it('refuses removing the last voting member', () => {
    const members = [voter(0), voter(1, { priority: 0, votes: 0 })];
    const status = statusFor(members, { 0: { state: 'SECONDARY', health: 1 } });
    const plan = planWith(configOf(members), { kind: 'remove', memberId: 0 }, status);
    expect(plan.refused).toBe('At least one member must vote.');
  });

  it('removes a voter from a two-voter set when the other voter is reachable', () => {
    const members = [voter(0), voter(1)];
    const plan = planWith(configOf(members), { kind: 'remove', memberId: 1 }, statusFor(members));
    expect(plan.refused).toBeUndefined();
    expect(plan.warnings[0]).toContain('The set has 1 voting members, down from 2.');
  });
});

describe('planReconfig: update', () => {
  it('sets priority 0 and votes 0 on a secondary and reports both changes', () => {
    const plan = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 2, patch: { priority: 0, votes: 0 } },
      healthyThree,
    );
    expect(plan.refused).toBeUndefined();
    expect(plan.changes).toEqual([
      'Set priority of mongo2:27017 from 1 to 0.',
      'Set votes of mongo2:27017 from 1 to 0.',
      'Raise the configuration version from 3 to 4.',
    ]);
    expect(plan.next.members.find((member) => member.id === 2)).toMatchObject({
      priority: 0,
      votes: 0,
    });
    expect(plan.warnings).toEqual([
      'The set has 2 voting members, down from 3. It tolerates 0 failed voting members, down from 1.',
    ]);
  });

  it('refuses votes 0 while the priority stays above 0', () => {
    const plan = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 2, patch: { votes: 0 } },
      healthyThree,
    );
    expect(plan.refused).toBe('mongo2:27017 has no votes, so its priority must be 0.');
  });

  it('refuses a votes change that leaves the voters without a reachable majority', () => {
    const status = statusFor(threeVoters, { 1: UNREACHABLE, 2: UNREACHABLE });
    const plan = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 0, patch: { votes: 0, priority: 0 } },
      status,
    );
    expect(plan.refused).toBe(
      'Only 0 of 2 voting members would be reachable, and a majority needs 2. This change would leave the set without a majority.',
    );
  });

  it('refuses a votes change to 0 on a healthy member while a voter is unreachable', () => {
    const status = statusFor(threeVoters, { 2: UNREACHABLE });
    const plan = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 1, patch: { votes: 0, priority: 0 } },
      status,
    );
    expect(plan.refused).toBe(
      'Only 1 of 2 voting members would be reachable, and a majority needs 2. This change would leave the set without a majority.',
    );
  });

  it('refuses a votes value outside 0 and 1', () => {
    const plan = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 1, patch: { votes: 3 } },
      healthyThree,
    );
    expect(plan.refused).toBe('mongo1:27017 has 3 votes. A member has 0 or 1 votes.');
  });

  it('corrects a hidden member with priority above 0 to 0 with a warning', () => {
    const plan = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 1, patch: { hidden: true } },
      healthyThree,
    );
    expect(plan.refused).toBeUndefined();
    expect(plan.next.members.find((member) => member.id === 1)).toMatchObject({
      hidden: true,
      priority: 0,
    });
    expect(plan.warnings).toEqual([
      'mongo1:27017 is hidden, so its priority is set to 0 instead of 1.',
    ]);
    expect(plan.changes).toContain('Set hidden of mongo1:27017 from false to true.');
    expect(plan.changes).toContain('Set priority of mongo1:27017 from 1 to 0.');
  });

  it('refuses an arbiter that gets priority above 0', () => {
    const members = [voter(0), voter(1, { arbiterOnly: true, priority: 0 }), voter(2)];
    const plan = planWith(
      configOf(members),
      { kind: 'update', memberId: 1, patch: { priority: 2 } },
      statusFor(members),
    );
    expect(plan.refused).toBe('mongo1:27017 is an arbiter, so its priority must be 0.');
  });

  it('refuses a delay on a member whose priority stays above 0', () => {
    const plan = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 2, patch: { secondaryDelaySecs: 60 } },
      healthyThree,
    );
    expect(plan.refused).toBe('mongo2:27017 is delayed, so its priority must be 0.');
  });

  it('applies a delay together with priority 0 and warns about the delay', () => {
    const plan = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 2, patch: { secondaryDelaySecs: 60, priority: 0 } },
      healthyThree,
    );
    expect(plan.refused).toBeUndefined();
    expect(plan.warnings).toEqual([
      'mongo2:27017 is delayed by 60 seconds. It never becomes primary, and its data lags by that delay.',
    ]);
  });

  it('warns that the primary steps down when its priority becomes 0', () => {
    const plan = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 0, patch: { priority: 0 } },
      healthyThree,
    );
    expect(plan.refused).toBeUndefined();
    expect(plan.warnings).toEqual([
      'mongo0:27017 is the primary, so it steps down once its priority is 0.',
    ]);
  });

  it('refuses a patch that changes the id of a member', () => {
    const plan = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 1, patch: { id: 7 } },
      healthyThree,
    );
    expect(plan.refused).toBe(
      'Member mongo1:27017 keeps its id 1. Remove it and add the new member instead.',
    );
  });

  it('refuses a patch that changes the host of a member', () => {
    const plan = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 1, patch: { host: 'elsewhere:27017' } },
      healthyThree,
    );
    expect(plan.refused).toBe(
      'Member 1 keeps its host mongo1:27017. Remove it and add the new member instead.',
    );
  });

  it('accepts a patch that repeats the current id and host', () => {
    const plan = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 1, patch: { id: 1, host: 'mongo1:27017', priority: 3 } },
      healthyThree,
    );
    expect(plan.refused).toBeUndefined();
    expect(plan.changes).toContain('Set priority of mongo1:27017 from 1 to 3.');
  });

  it('refuses an update of an unknown member id', () => {
    const plan = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 8, patch: { priority: 2 } },
      healthyThree,
    );
    expect(plan.refused).toBe('No member has id 8.');
  });

  it('refuses an empty patch and a patch that repeats the current values', () => {
    const empty = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 1, patch: {} },
      healthyThree,
    );
    expect(empty.refused).toBe('The change leaves the configuration as it is.');

    const same = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 1, patch: { priority: 1, votes: 1 } },
      healthyThree,
    );
    expect(same.refused).toBe('The change leaves the configuration as it is.');
  });

  it('reports tag changes with the old and new values', () => {
    const plan = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 1, patch: { tags: { dc: 'east' } } },
      healthyThree,
    );
    expect(plan.changes).toContain('Set tags of mongo1:27017 from {} to {"dc":"east"}.');
  });

  it('reports a build indexes change', () => {
    const plan = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 1, patch: { buildIndexes: false } },
      healthyThree,
    );
    expect(plan.changes).toContain('Set build indexes of mongo1:27017 from true to false.');
  });

  it('refuses a patch that makes an arbiter hidden', () => {
    const members = [voter(0), voter(1, { arbiterOnly: true, priority: 0 }), voter(2)];
    const plan = planWith(
      configOf(members),
      { kind: 'update', memberId: 1, patch: { hidden: true } },
      statusFor(members),
    );
    expect(plan.refused).toBe('mongo1:27017 is an arbiter, and an arbiter cannot be hidden.');
  });

  it('refuses a member with a negative priority', () => {
    const plan = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 1, patch: { priority: -1 } },
      healthyThree,
    );
    expect(plan.refused).toContain('has priority -1. Priority must be from 0 to 1000.');
  });

  it('refuses a member with a non-finite priority', () => {
    const plan = planWith(
      configOf(threeVoters),
      { kind: 'update', memberId: 1, patch: { priority: Number.NaN } },
      healthyThree,
    );
    expect(plan.refused).toContain('Priority must be from 0 to 1000.');
  });
});

describe('planReconfig: member counts and the reachable majority', () => {
  it('refuses a removal that leaves a five-voter set without a majority', () => {
    const members = Array.from({ length: 5 }, (_, id) => voter(id));
    const status = statusFor(members, { 3: UNREACHABLE, 4: UNREACHABLE });
    const plan = planWith(configOf(members), { kind: 'remove', memberId: 2 }, status);
    expect(plan.refused).toBe(
      'Only 2 of 4 voting members would be reachable, and a majority needs 3. This change would leave the set without a majority.',
    );
  });

  it('accepts a removal from a five-voter set with every member healthy', () => {
    const members = Array.from({ length: 5 }, (_, id) => voter(id));
    const plan = planWith(configOf(members), { kind: 'remove', memberId: 4 }, statusFor(members));
    expect(plan.refused).toBeUndefined();
    expect(plan.warnings[0]).toBe(
      'The set has 4 voting members, down from 5. It tolerates 1 failed voting members, down from 2.',
    );
  });

  it('counts a member missing from the status as unreachable', () => {
    const status = statusFor(threeVoters);
    const trimmed: ReplicaSetStatus = {
      ...status,
      members: status.members.filter((member) => member.id !== 2),
    };
    const plan = planWith(configOf(threeVoters), { kind: 'remove', memberId: 1 }, trimmed);
    expect(plan.refused).toContain('Only 1 of 2 voting members would be reachable');
  });

  it('refuses a 51st member even when every member is healthy', () => {
    const members = Array.from({ length: 50 }, (_, id) => voter(id, { votes: 0, priority: 0 }));
    const plan = planWith(
      configOf(members),
      { kind: 'add', member: { host: 'x:1', votes: 0 } },
      statusFor(members),
    );
    expect(plan.refused).toContain('at most 50 members');
  });
});

describe('planReconfig: the planned change type', () => {
  it('accepts every change kind', () => {
    const changes: ReconfigChange[] = [
      { kind: 'add', member: { host: 'mongo3:27017' } },
      { kind: 'remove', memberId: 2 },
      { kind: 'update', memberId: 1, patch: { priority: 2 } },
    ];
    for (const change of changes) {
      expect(planWith(configOf(threeVoters), change, healthyThree).refused).toBeUndefined();
    }
  });
});

describe('planReconfig: the healthy and primary views', () => {
  it('reads the healthy flag from the status, not from the config', () => {
    const status = statusFor(threeVoters, { 1: { state: 'SECONDARY', health: 0 } });
    const plan = planWith(configOf(threeVoters), { kind: 'remove', memberId: 2 }, status);
    expect(plan.refused).toContain('Only 1 of 2 voting members would be reachable');
  });

  it('treats a member that reports state PRIMARY as the primary even when status.primary is unset', () => {
    const status: ReplicaSetStatus = { setName: 'rs0', myState: 1, members: healthyThree.members };
    const plan = planWith(configOf(threeVoters), { kind: 'remove', memberId: 0 }, status);
    expect(plan.refused).toContain('is the primary');
  });
});
