import {
  AppErrorException,
  rpcContract,
  type ReconfigChange,
  type ReconfigPlan,
  type ReplicaSetConfig,
  type ReplicaSetMemberConfig,
  type ReplicaSetMemberPatch,
  type ReplicaSetStatus,
  type RpcClient,
} from '@mongo-gui/core';
import { fail, method } from './mock-support';

/** A command the server refused, with the server's error name the UI reads by code. */
function serverRefusal(codeName: string, detail: string): AppErrorException {
  return new AppErrorException({
    code: 'COMMAND_FAILED',
    message: 'The server rejected the command',
    detail,
    codeName,
  });
}

/** Replica set state of one mock connection. */
export type MockReplicaMode = 'standalone' | 'uninitiated' | 'member';

export interface MockReplicationOptions {
  readonly latencyMs: number;
  /** Throws unless the vault is unlocked and the connection is connected. */
  guard(connectionId: string): void;
  /** Runs after a call changes what the connection reports, such as the topology after initiate. */
  onChange(connectionId: string): void;
  readonly now?: () => number;
}

export interface MockReplicaSetInfo {
  readonly topology: 'standalone' | 'replicaSet' | 'unknown';
  readonly setName?: string;
  readonly hosts: readonly string[];
}

export interface MockReplicationMock {
  readonly rpc: RpcClient['replication'];
  /** Sets the mode of a connection. The seeded set is the one a `member` connection starts with. */
  setMode(connectionId: string, mode: MockReplicaMode): void;
  /** The topology a connection reports once it is connected. */
  infoFor(connectionId: string): MockReplicaSetInfo;
}

interface MockMember {
  id: number;
  host: string;
  state: 'PRIMARY' | 'SECONDARY' | 'ARBITER';
  priority: number;
  votes: number;
  hidden: boolean;
  arbiterOnly: boolean;
  buildIndexes: boolean;
  secondaryDelaySecs: number;
  tags: Record<string, string>;
  // Seconds behind the primary. Only data members carry an optime.
  lagSeconds: number | undefined;
}

interface MockSet {
  setName: string;
  version: number;
  term: number;
  members: MockMember[];
  // The member the connection points at. Step-down and freeze act on it.
  self: string;
  plans: Map<string, ReconfigPlan>;
}

const STATE_CODES = { PRIMARY: 1, SECONDARY: 2, ARBITER: 7 } as const;
const MOCK_SET_NAME = 'rs0';
const MOCK_HOST = 'localhost:27017';
const PRIMARY_OPTIME_MS = Date.UTC(2026, 9, 9, 10, 0, 10);
const OPLOG_FIRST_AGO_MS = 3_600_000;
const OPLOG_SIZE_MB = 512;
const OPLOG_USED_MB = 40;
const ELECTION_AGO_MS = 3_600_000;
const MAX_MEMBERS = 50;
const MAX_MEMBER_ID = 255;
const MAX_PRIORITY = 1000;
const MAX_STEP_DOWN = 3600;
const UNINITIATED_DETAIL = 'no replset config has been received';
const STANDALONE_DETAIL = 'not running with --replSet';
const NOT_INITIALISED = 'NotYetInitialized';
const NO_REPLICATION = 'NoReplicationEnabled';
const ALREADY_INITIALISED = 'AlreadyInitialized';
const DEFAULT_CATCH_UP_SECONDS = 10;

function seededMembers(): MockMember[] {
  return [
    {
      id: 0,
      host: MOCK_HOST,
      state: 'PRIMARY',
      priority: 2,
      votes: 1,
      hidden: false,
      arbiterOnly: false,
      buildIndexes: true,
      secondaryDelaySecs: 0,
      tags: { dc: 'east' },
      lagSeconds: undefined,
    },
    {
      id: 1,
      host: 'localhost:27018',
      state: 'SECONDARY',
      priority: 1,
      votes: 1,
      hidden: false,
      arbiterOnly: false,
      buildIndexes: true,
      secondaryDelaySecs: 0,
      tags: { dc: 'east' },
      lagSeconds: 2.5,
    },
    {
      id: 2,
      host: 'localhost:27019',
      state: 'ARBITER',
      priority: 0,
      votes: 1,
      hidden: false,
      arbiterOnly: true,
      buildIndexes: true,
      secondaryDelaySecs: 0,
      tags: {},
      lagSeconds: undefined,
    },
  ];
}

function seededSet(): MockSet {
  return {
    setName: MOCK_SET_NAME,
    version: 4,
    term: 2,
    members: seededMembers(),
    self: MOCK_HOST,
    plans: new Map(),
  };
}

/**
 * The replica set mock. It follows the adapter's rules for the common cases: refused plans for a
 * removed primary, a duplicate host, an arbiter that turns into a data member, and a stale version
 * on apply. The adapter holds the full planner and its tests.
 */
export function createMockReplication(options: MockReplicationOptions): MockReplicationMock {
  const { latencyMs, guard } = options;
  const now = options.now ?? Date.now;
  const modes = new Map<string, MockReplicaMode>();
  const sets = new Map<string, MockSet>();

  function modeOf(connectionId: string): MockReplicaMode {
    return modes.get(connectionId) ?? 'standalone';
  }

  function setOf(connectionId: string): MockSet {
    const found = sets.get(connectionId);
    if (found === undefined) {
      throw serverRefusal(NO_REPLICATION, STANDALONE_DETAIL);
    }
    return found;
  }

  /** Requires an initiated set. A standalone or uninitiated node reports why it has none. */
  function requireSet(connectionId: string): MockSet {
    const mode = modeOf(connectionId);
    if (mode === 'standalone') {
      throw serverRefusal(NO_REPLICATION, STANDALONE_DETAIL);
    }
    if (mode === 'uninitiated') {
      throw serverRefusal(NOT_INITIALISED, UNINITIATED_DETAIL);
    }
    return setOf(connectionId);
  }

  function requirePrimary(set: MockSet): MockMember {
    const primary = set.members.find((member) => member.state === 'PRIMARY');
    if (primary === undefined) {
      throw fail('COMMAND_FAILED', 'No primary in the set');
    }
    return primary;
  }

  function selfMember(set: MockSet): MockMember {
    const member = set.members.find((item) => item.host === set.self);
    if (member === undefined) {
      throw fail('COMMAND_FAILED', 'The connected member is not in the set');
    }
    return member;
  }

  function statusOf(set: MockSet): ReplicaSetStatus {
    const primary = set.members.find((member) => member.state === 'PRIMARY');
    const primaryOptime = PRIMARY_OPTIME_MS;
    const electionDate = new Date(now() - ELECTION_AGO_MS).toISOString();
    return {
      setName: set.setName,
      myState: STATE_CODES[selfMember(set).state],
      term: set.term,
      primary: primary?.host,
      majorityVoteCount: Math.floor(votingCount(set.members) / 2) + 1,
      writeMajorityCount: Math.floor(votingCount(set.members) / 2) + 1,
      oplog: {
        firstTs: new Date(now() - OPLOG_FIRST_AGO_MS).toISOString(),
        lastTs: new Date(now()).toISOString(),
        windowSeconds: OPLOG_FIRST_AGO_MS / 1000,
        sizeMb: OPLOG_SIZE_MB,
        usedMb: OPLOG_USED_MB,
      },
      electionCandidateMetrics: {
        lastElectionReason: 'electionTimeout',
        termAtLastElection: set.term,
        lastElectionDate: electionDate,
      },
      members: set.members.map((member) => ({
        id: member.id,
        name: member.host,
        state: member.state,
        stateCode: STATE_CODES[member.state],
        health: 1,
        uptimeSeconds: 86_400,
        ...(member.arbiterOnly
          ? {}
          : {
              optimeDate: new Date(primaryOptime - (member.lagSeconds ?? 0) * 1000).toISOString(),
            }),
        ...(member.lagSeconds === undefined || member.state === 'PRIMARY'
          ? {}
          : { lagSeconds: member.lagSeconds }),
        ...(member.state === 'PRIMARY' ? { electionDate } : {}),
        ...(member.state === 'SECONDARY' && primary !== undefined
          ? { syncSourceHost: primary.host }
          : {}),
        self: member.host === set.self,
        priority: member.priority,
        votes: member.votes,
        hidden: member.hidden,
        arbiterOnly: member.arbiterOnly,
        buildIndexes: member.buildIndexes,
        secondaryDelaySecs: member.secondaryDelaySecs,
        tags: { ...member.tags },
        configVersion: set.version,
      })),
    };
  }

  function configOf(set: MockSet): ReplicaSetConfig {
    return {
      id: set.setName,
      version: set.version,
      term: set.term,
      protocolVersion: 1,
      members: set.members.map(toConfigMember),
      settingsEjson: '{}',
      extraEjson: '{}',
    };
  }

  function toConfigMember(member: MockMember): ReplicaSetMemberConfig {
    return {
      id: member.id,
      host: member.host,
      priority: member.priority,
      votes: member.votes,
      hidden: member.hidden,
      arbiterOnly: member.arbiterOnly,
      buildIndexes: member.buildIndexes,
      secondaryDelaySecs: member.secondaryDelaySecs,
      tags: { ...member.tags },
      extraEjson: '{}',
    };
  }

  function planFor(set: MockSet, change: ReconfigChange): ReconfigPlan {
    const current = configOf(set);
    const refusals: string[] = [];
    const warnings: string[] = [];
    const changes: string[] = [];
    let members = set.members.map((member) => ({ ...member }));
    if (change.kind === 'add') {
      const input = change.member;
      if (members.some((member) => member.host === input.host)) {
        refusals.push(`${input.host} is already a member of the set.`);
      } else if (members.length >= MAX_MEMBERS) {
        refusals.push(`A replica set has at most ${MAX_MEMBERS} members.`);
      } else {
        const hidden = input.hidden ?? false;
        const arbiterOnly = input.arbiterOnly ?? false;
        const votes = input.votes ?? 1;
        const delay = input.secondaryDelaySecs ?? 0;
        const priority =
          input.priority ?? (hidden || arbiterOnly || votes === 0 || delay > 0 ? 0 : 1);
        const id = smallestFreeId(members);
        members.push({
          id,
          host: input.host,
          state: arbiterOnly ? 'ARBITER' : 'SECONDARY',
          priority,
          votes,
          hidden,
          arbiterOnly,
          buildIndexes: input.buildIndexes ?? true,
          secondaryDelaySecs: delay,
          tags: { ...(input.tags ?? {}) },
          lagSeconds: arbiterOnly ? undefined : 0,
        });
        changes.push(`Add ${input.host} as member ${id}.`);
      }
    } else if (change.kind === 'remove') {
      const target = members.find((member) => member.id === change.memberId);
      if (target === undefined) {
        refusals.push(`No member has id ${change.memberId}.`);
      } else if (target.state === 'PRIMARY') {
        refusals.push(`${target.host} is the primary. Step it down before removing it.`);
      } else if (members.length === 1) {
        refusals.push('The only member of the set cannot be removed.');
      } else {
        members = members.filter((member) => member.id !== target.id);
        changes.push(`Remove ${target.host} (member ${target.id}).`);
      }
    } else {
      const target = members.find((member) => member.id === change.memberId);
      if (target === undefined) {
        refusals.push(`No member has id ${change.memberId}.`);
      } else {
        const edited = applyPatch(target, change.patch, refusals);
        if (edited !== undefined) {
          if (edited.hidden && edited.priority > 0) {
            warnings.push(
              `${target.host} is hidden, so its priority is set to 0 instead of ${edited.priority}.`,
            );
            edited.priority = 0;
          }
          members = members.map((member) => (member.id === target.id ? edited : member));
          for (const [key, label] of EDITABLE_LABELS) {
            if (JSON.stringify(target[key]) !== JSON.stringify(edited[key])) {
              changes.push(
                `Set ${label} of ${target.host} from ${JSON.stringify(target[key])} to ${JSON.stringify(edited[key])}.`,
              );
            }
          }
          if (changes.length === 0) {
            refusals.push('The change leaves the configuration as it is.');
          }
        }
      }
    }
    if (votingCount(members) === 0) {
      refusals.push('The set would have no voting member.');
    }
    changes.push(`Raise the configuration version from ${set.version} to ${set.version + 1}.`);
    const next: ReplicaSetConfig = {
      ...current,
      version: set.version + 1,
      members: members.sort((a, b) => a.id - b.id).map(toConfigMember),
    };
    const refused = refusals.length > 0 ? refusals.join(' ') : undefined;
    return {
      current,
      next,
      changes: refused === undefined ? changes : [],
      warnings,
      ...(refused === undefined ? {} : { refused }),
    };
  }

  const rpc: RpcClient['replication'] = {
    getStatus: method(rpcContract.replication.getStatus, latencyMs, ({ connectionId }) => {
      guard(connectionId);
      return statusOf(requireSet(connectionId));
    }),
    selfHost: method(rpcContract.replication.selfHost, latencyMs, ({ connectionId }) => {
      guard(connectionId);
      // A node names itself by the address it listens on. The mock's local node is MOCK_HOST.
      return { host: MOCK_HOST };
    }),
    getConfig: method(rpcContract.replication.getConfig, latencyMs, ({ connectionId }) => {
      guard(connectionId);
      return configOf(requireSet(connectionId));
    }),
    planReconfig: method(
      rpcContract.replication.planReconfig,
      latencyMs,
      ({ connectionId, change }) => {
        guard(connectionId);
        const set = requireSet(connectionId);
        const plan = planFor(set, change);
        const planId = globalThis.crypto.randomUUID();
        set.plans.set(planId, plan);
        return { planId, plan };
      },
    ),
    applyReconfig: method(
      rpcContract.replication.applyReconfig,
      latencyMs,
      ({ connectionId, planId, expectedVersion }) => {
        guard(connectionId);
        const set = requireSet(connectionId);
        const plan = set.plans.get(planId);
        set.plans.delete(planId);
        if (plan === undefined) {
          throw fail('VALIDATION', 'The plan is no longer available. Plan the change again.');
        }
        if (set.version !== expectedVersion || plan.current.version !== set.version) {
          throw fail(
            'VALIDATION',
            `The configuration moved from version ${plan.current.version} to ${set.version} after the plan was made. Plan the change again.`,
          );
        }
        if (plan.refused !== undefined) {
          throw fail('VALIDATION', plan.refused);
        }
        set.members = plan.next.members.map((member) => fromConfigMember(member, set.members));
        set.version = plan.next.version;
        options.onChange(connectionId);
      },
    ),
    stepDown: method(
      rpcContract.replication.stepDown,
      latencyMs,
      ({ connectionId, stepDownSeconds }) => {
        guard(connectionId);
        const set = requireSet(connectionId);
        // The contract refuses anything under the minimum before this runs. The check here keeps the
        // server's rule next to the mock: the step-down must outlast the 10 second catch-up.
        if (stepDownSeconds <= DEFAULT_CATCH_UP_SECONDS) {
          throw fail(
            'VALIDATION',
            `The step-down period must be longer than the catch-up period of ${DEFAULT_CATCH_UP_SECONDS} seconds`,
          );
        }
        if (stepDownSeconds > MAX_STEP_DOWN) {
          throw fail('VALIDATION', 'Step down at most 3600 seconds');
        }
        const primary = requirePrimary(set);
        if (primary.host !== set.self) {
          throw fail('COMMAND_FAILED', 'The connected member is not the primary');
        }
        const successor = set.members.find(
          (member) => member.state === 'SECONDARY' && member.priority > 0 && !member.hidden,
        );
        if (successor === undefined) {
          throw fail('COMMAND_FAILED', 'No electable secondary to take over');
        }
        primary.state = 'SECONDARY';
        successor.state = 'PRIMARY';
        successor.lagSeconds = 0;
        set.term += 1;
        return { primary: successor.host };
      },
    ),
    freeze: method(rpcContract.replication.freeze, latencyMs, ({ connectionId }) => {
      guard(connectionId);
      requireSet(connectionId);
    }),
    initiate: method(
      rpcContract.replication.initiate,
      latencyMs,
      ({ connectionId, setName, members }) => {
        guard(connectionId);
        if (modeOf(connectionId) !== 'uninitiated') {
          throw serverRefusal(ALREADY_INITIALISED, 'already initialized');
        }
        const self =
          members.find((member) => member.host === MOCK_HOST)?.host ??
          members[0]?.host ??
          MOCK_HOST;
        const first = members[0]?.host ?? MOCK_HOST;
        sets.set(connectionId, {
          setName,
          version: 1,
          term: 1,
          members: members.map((member, index) => ({
            id: index,
            host: member.host,
            state: member.host === first ? 'PRIMARY' : 'SECONDARY',
            priority: member.priority ?? 1,
            votes: 1,
            hidden: false,
            arbiterOnly: false,
            buildIndexes: true,
            secondaryDelaySecs: 0,
            tags: {},
            lagSeconds: member.host === first ? undefined : 0,
          })),
          self,
          plans: new Map(),
        });
        modes.set(connectionId, 'member');
        options.onChange(connectionId);
      },
    ),
  };

  return {
    rpc,
    setMode(connectionId, mode) {
      modes.set(connectionId, mode);
      if (mode === 'member') {
        sets.set(connectionId, seededSet());
      } else {
        sets.delete(connectionId);
      }
    },
    infoFor(connectionId) {
      const mode = modeOf(connectionId);
      if (mode === 'member') {
        return {
          topology: 'replicaSet',
          setName: setOf(connectionId).setName,
          hosts: setOf(connectionId).members.map((member) => member.host),
        };
      }
      if (mode === 'uninitiated') {
        return { topology: 'unknown', hosts: [MOCK_HOST] };
      }
      return { topology: 'standalone', hosts: [MOCK_HOST] };
    },
  };
}

const EDITABLE_LABELS: readonly [keyof MockMember, string][] = [
  ['priority', 'priority'],
  ['votes', 'votes'],
  ['hidden', 'hidden'],
  ['secondaryDelaySecs', 'delay in seconds'],
  ['tags', 'tags'],
];

function votingCount(members: readonly MockMember[]): number {
  return members.reduce((sum, member) => sum + member.votes, 0);
}

function smallestFreeId(members: readonly MockMember[]): number {
  const used = new Set(members.map((member) => member.id));
  for (let id = 0; id <= MAX_MEMBER_ID; id += 1) {
    if (!used.has(id)) {
      return id;
    }
  }
  throw fail('VALIDATION', 'Every member id is in use');
}

/** Applies a patch to a member. Returns undefined and records a refusal for a breach of a rule. */
function applyPatch(
  target: MockMember,
  patch: ReplicaSetMemberPatch,
  refusals: string[],
): MockMember | undefined {
  if (patch.id !== undefined && patch.id !== target.id) {
    refusals.push(
      `Member ${target.host} keeps its id ${target.id}. Remove it and add the new member instead.`,
    );
    return undefined;
  }
  if (patch.host !== undefined && patch.host !== target.host) {
    refusals.push(
      `Member ${target.id} keeps its host ${target.host}. Remove it and add the new member instead.`,
    );
    return undefined;
  }
  if (patch.arbiterOnly !== undefined && patch.arbiterOnly !== target.arbiterOnly) {
    refusals.push(
      `Member ${target.host} cannot change between an arbiter and a data member. Remove it and add the new member instead.`,
    );
    return undefined;
  }
  const priority = patch.priority ?? target.priority;
  if (priority < 0 || priority > MAX_PRIORITY) {
    refusals.push(`Priority must be between 0 and ${MAX_PRIORITY}.`);
    return undefined;
  }
  return {
    ...target,
    priority,
    votes: patch.votes ?? target.votes,
    hidden: patch.hidden ?? target.hidden,
    secondaryDelaySecs: patch.secondaryDelaySecs ?? target.secondaryDelaySecs,
    tags: patch.tags === undefined ? { ...target.tags } : { ...patch.tags },
  };
}

function fromConfigMember(
  member: ReplicaSetMemberConfig,
  previous: readonly MockMember[],
): MockMember {
  const known = previous.find((item) => item.id === member.id);
  return {
    id: member.id,
    host: member.host,
    state: member.arbiterOnly ? 'ARBITER' : known?.state === 'PRIMARY' ? 'PRIMARY' : 'SECONDARY',
    priority: member.priority,
    votes: member.votes,
    hidden: member.hidden,
    arbiterOnly: member.arbiterOnly,
    buildIndexes: member.buildIndexes,
    secondaryDelaySecs: member.secondaryDelaySecs,
    tags: { ...member.tags },
    lagSeconds: member.arbiterOnly ? undefined : (known?.lagSeconds ?? 0),
  };
}
