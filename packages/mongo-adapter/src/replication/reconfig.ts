import { BSON, type MongoClient } from 'mongodb';
import {
  AddMemberInputSchema,
  AppErrorException,
  appError,
  MAX_REPLICA_SET_MEMBERS,
  MAX_VOTING_MEMBERS,
  MAX_MEMBER_PRIORITY,
  RemoveMemberInputSchema,
  UpdateMemberInputSchema,
  type AddMemberInput,
  type ReconfigChange,
  type ReconfigPlan,
  type ReplicaSetConfig,
  type ReplicaSetMemberConfig,
  type ReplicaSetMemberPatch,
  type ReplicaSetStatus,
} from '@mongo-gui/core';
import { parseInput } from '../management/errors';
import { readNumber } from '../documents';
import { mapDriverError } from '../errors';
import { getReplicaSetConfig, getReplicaSetStatus } from './status';

export interface ApplyOptions {
  // Passed to replSetReconfig. It lets the server reconfigure without a majority, so it does not
  // lift a refusal in the plan. The planner refuses every change that would lose a majority.
  readonly force?: boolean;
}

const MAX_MEMBER_ID = 255;
const HEALTHY = 1;
// Wire version 13 is MongoDB 5.0. Earlier servers accept only the slaveDelay name.
const WIRE_VERSION_WITH_SECONDARY_DELAY = 13;
const CHANGED_FIELDS: readonly { key: keyof ReplicaSetMemberConfig; label: string }[] = [
  { key: 'priority', label: 'priority' },
  { key: 'votes', label: 'votes' },
  { key: 'hidden', label: 'hidden' },
  { key: 'arbiterOnly', label: 'arbiter' },
  { key: 'buildIndexes', label: 'build indexes' },
  { key: 'secondaryDelaySecs', label: 'delay in seconds' },
  { key: 'tags', label: 'tags' },
];

interface Notes {
  readonly refusals: string[];
  readonly warnings: string[];
  readonly changes: string[];
}

// Builds the dry-run summary for one change. The function reads its inputs and does no I/O, so
// every rule can be tested with a literal configuration and status.
export function planReconfig(
  current: ReplicaSetConfig,
  change: ReconfigChange,
  status: ReplicaSetStatus,
): ReconfigPlan {
  const notes: Notes = { refusals: [], warnings: [], changes: [] };
  const members = applyChange(current.members, change, status, notes);
  if (notes.changes.length === 0 && notes.refusals.length === 0) {
    notes.refusals.push('The change leaves the configuration as it is.');
  }
  validateSet(members, status, notes);
  reportVotingLoss(current.members, members, notes);
  const next: ReplicaSetConfig = {
    ...current,
    version: current.version + 1,
    members: [...members].sort((left, right) => left.id - right.id),
  };
  notes.changes.push(`Raise the configuration version from ${current.version} to ${next.version}.`);
  const refused = notes.refusals.length > 0 ? notes.refusals.join(' ') : undefined;
  return {
    current,
    next,
    changes: notes.changes,
    warnings: notes.warnings,
    ...(refused === undefined ? {} : { refused }),
  };
}

// Runs the planned replSetReconfig. A refused plan throws and sends nothing. The live version must
// still match the plan, so a configuration change made after planning stops this change.
export async function applyReconfig(
  client: MongoClient,
  plan: ReconfigPlan,
  options: ApplyOptions = {},
): Promise<void> {
  if (plan.refused !== undefined) {
    throw new AppErrorException(appError('VALIDATION', plan.refused));
  }
  try {
    const live = await getReplicaSetConfig(client);
    if (live.version !== plan.current.version) {
      throw new AppErrorException(
        appError(
          'VALIDATION',
          `The configuration moved from version ${plan.current.version} to ${live.version} after the plan was made. Plan the change again.`,
        ),
      );
    }
    const delayField = await secondaryDelayField(client);
    await client.db('admin').command({
      replSetReconfig: toServerConfig(plan.next, delayField),
      ...(options.force === true ? { force: true } : {}),
    });
  } catch (error) {
    throw error instanceof AppErrorException ? error : new AppErrorException(mapDriverError(error));
  }
}

export async function addMember(client: MongoClient, input: unknown): Promise<ReconfigPlan> {
  const member = parseInput<AddMemberInput>(AddMemberInputSchema, input);
  return planAndApply(client, { kind: 'add', member });
}

export async function removeMember(client: MongoClient, input: unknown): Promise<ReconfigPlan> {
  const parsed = parseInput<{ memberId: number }>(RemoveMemberInputSchema, input);
  return planAndApply(client, { kind: 'remove', memberId: parsed.memberId });
}

export async function updateMember(client: MongoClient, input: unknown): Promise<ReconfigPlan> {
  const parsed = parseInput<{ memberId: number; patch: ReplicaSetMemberPatch }>(
    UpdateMemberInputSchema,
    input,
  );
  return planAndApply(client, { kind: 'update', memberId: parsed.memberId, patch: parsed.patch });
}

async function planAndApply(client: MongoClient, change: ReconfigChange): Promise<ReconfigPlan> {
  const status = await getReplicaSetStatus(client);
  const config = await getReplicaSetConfig(client);
  const plan = planReconfig(config, change, status);
  await applyReconfig(client, plan);
  return plan;
}

function applyChange(
  members: readonly ReplicaSetMemberConfig[],
  change: ReconfigChange,
  status: ReplicaSetStatus,
  notes: Notes,
): ReplicaSetMemberConfig[] {
  switch (change.kind) {
    case 'add':
      return addChange(members, change.member, notes);
    case 'remove':
      return removeChange(members, change.memberId, status, notes);
    case 'update':
      return updateChange(members, change.memberId, change.patch, status, notes);
  }
}

function addChange(
  members: readonly ReplicaSetMemberConfig[],
  input: AddMemberInput,
  notes: Notes,
): ReplicaSetMemberConfig[] {
  if (members.some((member) => member.host === input.host)) {
    notes.refusals.push(`${input.host} is already a member of the set.`);
    return [...members];
  }
  const id = smallestFreeId(members);
  if (id === undefined) {
    notes.refusals.push(`The set already uses all member ids from 0 to ${MAX_MEMBER_ID}.`);
    return [...members];
  }
  const votes = input.votes ?? 1;
  const hidden = input.hidden ?? false;
  const arbiterOnly = input.arbiterOnly ?? false;
  const secondaryDelaySecs = input.secondaryDelaySecs ?? 0;
  // Members that cannot be electable or that serve no votes take priority 0 unless the caller
  // sets it, and the rules below check the explicit values.
  const defaultPriority = votes === 0 || hidden || arbiterOnly || secondaryDelaySecs > 0 ? 0 : 1;
  const candidate: ReplicaSetMemberConfig = {
    id,
    host: input.host,
    priority: input.priority ?? defaultPriority,
    votes,
    hidden,
    arbiterOnly,
    buildIndexes: input.buildIndexes ?? true,
    secondaryDelaySecs,
    tags: input.tags ?? {},
  };
  const checked = checkMember(candidate, notes);
  if (secondaryDelaySecs > 0) {
    notes.warnings.push(
      `${input.host} is delayed by ${secondaryDelaySecs} seconds. It never becomes primary, and its data lags by that delay.`,
    );
  }
  if (notes.refusals.length === 0) {
    notes.changes.push(
      `Add ${checked.host} as member ${checked.id}: priority ${checked.priority}, votes ${checked.votes}, hidden ${checked.hidden}, arbiter ${checked.arbiterOnly}, delay ${checked.secondaryDelaySecs} seconds.`,
    );
  }
  return [...members, checked];
}

function removeChange(
  members: readonly ReplicaSetMemberConfig[],
  memberId: number,
  status: ReplicaSetStatus,
  notes: Notes,
): ReplicaSetMemberConfig[] {
  const target = members.find((member) => member.id === memberId);
  if (target === undefined) {
    notes.refusals.push(`No member has id ${memberId}.`);
    return [...members];
  }
  if (isPrimary(target, status)) {
    notes.refusals.push(`${target.host} is the primary. Step it down before removing it.`);
    return [...members];
  }
  if (members.length === 1) {
    notes.refusals.push('The only member of the set cannot be removed.');
    return [...members];
  }
  notes.changes.push(`Remove ${target.host} (member ${target.id}).`);
  return members.filter((member) => member.id !== target.id);
}

function updateChange(
  members: readonly ReplicaSetMemberConfig[],
  memberId: number,
  patch: ReplicaSetMemberPatch,
  status: ReplicaSetStatus,
  notes: Notes,
): ReplicaSetMemberConfig[] {
  const target = members.find((member) => member.id === memberId);
  if (target === undefined) {
    notes.refusals.push(`No member has id ${memberId}.`);
    return [...members];
  }
  if (patch.id !== undefined && patch.id !== target.id) {
    notes.refusals.push(
      `Member ${target.host} keeps its id ${target.id}. Remove it and add the new member instead.`,
    );
    return [...members];
  }
  if (patch.host !== undefined && patch.host !== target.host) {
    notes.refusals.push(
      `Member ${target.id} keeps its host ${target.host}. Remove it and add the new member instead.`,
    );
    return [...members];
  }
  const edited: ReplicaSetMemberConfig = {
    ...target,
    priority: patch.priority ?? target.priority,
    votes: patch.votes ?? target.votes,
    hidden: patch.hidden ?? target.hidden,
    arbiterOnly: patch.arbiterOnly ?? target.arbiterOnly,
    buildIndexes: patch.buildIndexes ?? target.buildIndexes,
    secondaryDelaySecs: patch.secondaryDelaySecs ?? target.secondaryDelaySecs,
    tags: patch.tags ?? target.tags,
  };
  const failuresBefore = notes.refusals.length;
  const checked = checkMember(edited, notes);
  if (notes.refusals.length > failuresBefore) {
    return [...members];
  }
  const fieldChanges = CHANGED_FIELDS.filter(
    ({ key }) => JSON.stringify(target[key]) !== JSON.stringify(checked[key]),
  );
  for (const { key, label } of fieldChanges) {
    notes.changes.push(
      `Set ${label} of ${target.host} from ${JSON.stringify(target[key])} to ${JSON.stringify(checked[key])}.`,
    );
  }
  if (
    fieldChanges.length > 0 &&
    isPrimary(target, status) &&
    checked.priority === 0 &&
    target.priority > 0
  ) {
    notes.warnings.push(`${target.host} is the primary, so it steps down once its priority is 0.`);
  }
  if (checked.secondaryDelaySecs > 0 && checked.secondaryDelaySecs !== target.secondaryDelaySecs) {
    notes.warnings.push(
      `${target.host} is delayed by ${checked.secondaryDelaySecs} seconds. It never becomes primary, and its data lags by that delay.`,
    );
  }
  return members.map((member) => (member.id === target.id ? checked : member));
}

// Checks the rules for one member. A hidden member with priority above 0 is corrected to 0 with a
// warning, because the server requires it. Every other rule breach is a refusal. The function
// returns the member as it should be stored.
function checkMember(member: ReplicaSetMemberConfig, notes: Notes): ReplicaSetMemberConfig {
  const { host } = member;
  let corrected = member;
  if (member.hidden && member.priority > 0) {
    notes.warnings.push(
      `${host} is hidden, so its priority is set to 0 instead of ${member.priority}.`,
    );
    corrected = { ...member, priority: 0 };
  }
  if (corrected.votes !== 0 && corrected.votes !== 1) {
    notes.refusals.push(`${host} has ${corrected.votes} votes. A member has 0 or 1 votes.`);
  }
  if (
    !Number.isFinite(corrected.priority) ||
    corrected.priority < 0 ||
    corrected.priority > MAX_MEMBER_PRIORITY
  ) {
    notes.refusals.push(
      `${host} has priority ${corrected.priority}. Priority must be from 0 to ${MAX_MEMBER_PRIORITY}.`,
    );
  }
  if (!Number.isInteger(corrected.secondaryDelaySecs) || corrected.secondaryDelaySecs < 0) {
    notes.refusals.push(
      `${host} has a delay of ${corrected.secondaryDelaySecs} seconds. The delay must be a whole number of seconds from 0.`,
    );
  }
  if (corrected.votes === 0 && corrected.priority > 0) {
    notes.refusals.push(`${host} has no votes, so its priority must be 0.`);
  }
  if (corrected.secondaryDelaySecs > 0 && corrected.priority > 0) {
    notes.refusals.push(`${host} is delayed, so its priority must be 0.`);
  }
  if (corrected.arbiterOnly) {
    if (corrected.hidden) {
      notes.refusals.push(`${host} is an arbiter, and an arbiter cannot be hidden.`);
    }
    if (corrected.secondaryDelaySecs > 0) {
      notes.refusals.push(`${host} is an arbiter, and an arbiter cannot be delayed.`);
    }
    if (corrected.priority > 0) {
      notes.refusals.push(`${host} is an arbiter, so its priority must be 0.`);
    }
  }
  return corrected;
}

// Set-level rules: the member count, the voting count, and a reachable majority of voters after
// the change. A member that is not healthy in the status does not count as reachable. A member
// added by the change is not in the status yet, so it does not count either.
function validateSet(
  members: readonly ReplicaSetMemberConfig[],
  status: ReplicaSetStatus,
  notes: Notes,
): void {
  if (members.length > MAX_REPLICA_SET_MEMBERS) {
    notes.refusals.push(
      `A replica set has at most ${MAX_REPLICA_SET_MEMBERS} members, and this change would make ${members.length}.`,
    );
  }
  if (members.length === 0) {
    notes.refusals.push('The set needs at least one member.');
    return;
  }
  const voting = members.filter((member) => member.votes > 0);
  if (voting.length > MAX_VOTING_MEMBERS) {
    notes.refusals.push(
      `A replica set has at most ${MAX_VOTING_MEMBERS} voting members, and this change would make ${voting.length}.`,
    );
  }
  if (voting.length === 0) {
    notes.refusals.push('At least one member must vote.');
    return;
  }
  const reachable = voting.filter((member) => isHealthy(member.id, status)).length;
  const majority = Math.floor(voting.length / 2) + 1;
  if (reachable < majority) {
    notes.refusals.push(
      `Only ${reachable} of ${voting.length} voting members would be reachable, and a majority needs ${majority}. This change would leave the set without a majority.`,
    );
  }
}

function reportVotingLoss(
  before: readonly ReplicaSetMemberConfig[],
  after: readonly ReplicaSetMemberConfig[],
  notes: Notes,
): void {
  const votingBefore = before.filter((member) => member.votes > 0).length;
  const votingAfter = after.filter((member) => member.votes > 0).length;
  if (votingAfter >= votingBefore) {
    return;
  }
  notes.warnings.push(
    `The set has ${votingAfter} voting members, down from ${votingBefore}. It tolerates ${faultTolerance(votingAfter)} failed voting members, down from ${faultTolerance(votingBefore)}.`,
  );
}

function faultTolerance(voting: number): number {
  return Math.max(0, voting - (Math.floor(voting / 2) + 1));
}

function smallestFreeId(members: readonly ReplicaSetMemberConfig[]): number | undefined {
  const used = new Set(members.map((member) => member.id));
  for (let id = 0; id <= MAX_MEMBER_ID; id++) {
    if (!used.has(id)) {
      return id;
    }
  }
  return undefined;
}

function isPrimary(member: ReplicaSetMemberConfig, status: ReplicaSetStatus): boolean {
  if (status.primary === member.host) {
    return true;
  }
  return status.members.some((entry) => entry.id === member.id && entry.state === 'PRIMARY');
}

function isHealthy(id: number, status: ReplicaSetStatus): boolean {
  return status.members.some((entry) => entry.id === id && entry.health === HEALTHY);
}

// The server renamed slaveDelay to secondaryDelaySecs in 5.0. Older servers reject the new name.
async function secondaryDelayField(
  client: MongoClient,
): Promise<'secondaryDelaySecs' | 'slaveDelay'> {
  try {
    const hello: unknown = await client.db('admin').command({ hello: 1 });
    const wire = readNumber(hello, 'maxWireVersion');
    return wire !== undefined && wire < WIRE_VERSION_WITH_SECONDARY_DELAY
      ? 'slaveDelay'
      : 'secondaryDelaySecs';
  } catch (error) {
    throw new AppErrorException(mapDriverError(error));
  }
}

function toServerConfig(
  config: ReplicaSetConfig,
  delayField: 'secondaryDelaySecs' | 'slaveDelay',
): Record<string, unknown> {
  const document: Record<string, unknown> = {
    _id: config.id,
    version: config.version,
    members: config.members.map((member) => ({
      _id: member.id,
      host: member.host,
      priority: member.priority,
      votes: member.votes,
      hidden: member.hidden,
      arbiterOnly: member.arbiterOnly,
      buildIndexes: member.buildIndexes,
      tags: member.tags,
      [delayField]: member.secondaryDelaySecs,
    })),
  };
  if (config.term !== undefined) {
    document['term'] = config.term;
  }
  if (config.protocolVersion !== undefined) {
    document['protocolVersion'] = config.protocolVersion;
  }
  if (config.writeConcernMajorityJournalDefault !== undefined) {
    document['writeConcernMajorityJournalDefault'] = config.writeConcernMajorityJournalDefault;
  }
  const settings = BSON.EJSON.parse(config.settingsEjson, { relaxed: false });
  if (Object.keys(settings).length > 0) {
    document['settings'] = settings;
  }
  return document;
}
