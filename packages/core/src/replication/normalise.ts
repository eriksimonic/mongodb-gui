import { appError, AppErrorException } from '../domain/errors';
import {
  ReplicaSetConfigSchema,
  ReplicaSetStatusSchema,
  type ReplicaSetConfig,
  type ReplicaSetMember,
  type ReplicaSetMemberConfig,
  type ReplicaSetOplog,
  type ReplicaSetStatus,
} from './types';

// Raw replies as the driver returns them. Core narrows them with unknown-based helpers.
export interface RawReplicaSetReplies {
  // The reply of replSetGetStatus.
  readonly status: unknown;
  // The reply of replSetGetConfig, which wraps the configuration in a config field.
  readonly config: unknown;
  // The first and last entries of local.oplog.rs, each a document with a ts field.
  readonly oplogFirst?: unknown;
  readonly oplogLast?: unknown;
  // The reply of collStats for local.oplog.rs.
  readonly oplogStats?: unknown;
  // Canonical EJSON of the configuration settings, serialised by the adapter.
  readonly settingsEjson?: string;
}

const BYTES_PER_MB = 1024 * 1024;
const DEFAULT_PRIORITY = 1;
const DEFAULT_VOTES = 1;

// Members missing from the configuration get no votes and no priority. The status alone cannot
// say what they are allowed to do, so the conservative reading is taken.
const UNKNOWN_MEMBER_CONFIG: Omit<ReplicaSetMemberConfig, 'id' | 'host'> = {
  priority: 0,
  votes: 0,
  hidden: false,
  arbiterOnly: false,
  buildIndexes: true,
  secondaryDelaySecs: 0,
  tags: {},
};

export function normaliseReplicaSetConfig(reply: unknown, settingsEjson = '{}'): ReplicaSetConfig {
  const config = readObject(reply, 'config');
  const members = readArray(config, 'members').flatMap((member) => {
    const normalised = normaliseMemberConfig(member);
    return normalised === undefined ? [] : [normalised];
  });
  const parsed = ReplicaSetConfigSchema.safeParse({
    id: readString(config, '_id'),
    version: readNumber(config, 'version'),
    ...definedField('term', readNumber(config, 'term')),
    ...definedField('protocolVersion', readNumber(config, 'protocolVersion')),
    ...definedField(
      'writeConcernMajorityJournalDefault',
      readBoolean(config, 'writeConcernMajorityJournalDefault'),
    ),
    members,
    settingsEjson,
  });
  if (!parsed.success) {
    throw unexpectedReply('configuration');
  }
  return parsed.data;
}

export function normaliseReplicaSetStatus(replies: RawReplicaSetReplies): ReplicaSetStatus {
  const { status } = replies;
  const config = normaliseReplicaSetConfig(replies.config, replies.settingsEjson);
  const configById = new Map(config.members.map((member) => [member.id, member]));
  const rawMembers = readArray(status, 'members');
  const primaryOptime = primaryOptimeMs(rawMembers);
  const members = rawMembers.flatMap((member): ReplicaSetMember[] => {
    const normalised = normaliseMember(member, configById, primaryOptime);
    return normalised === undefined ? [] : [normalised];
  });
  const primary = members.find((member) => member.state === 'PRIMARY');
  const oplog = normaliseOplog(replies);
  const parsed = ReplicaSetStatusSchema.safeParse({
    setName: readString(status, 'set') ?? config.id,
    myState: readNumber(status, 'myState') ?? -1,
    ...definedField('term', readNumber(status, 'term')),
    members,
    ...definedField('primary', primary?.name),
    ...definedField('majorityVoteCount', readNumber(status, 'majorityVoteCount')),
    ...definedField('writeMajorityCount', readNumber(status, 'writeMajorityCount')),
    ...definedField('oplog', oplog),
    ...definedField('electionCandidateMetrics', readField(status, 'electionCandidateMetrics')),
  });
  if (!parsed.success) {
    throw unexpectedReply('status');
  }
  return parsed.data;
}

// Lag is the distance from the primary's optime, for a healthy secondary with a real optime. The
// primary reports no lag, and an unreachable member reports a zero or stale optime. This follows
// the rule in the monitor's derive module.
export function memberLagSeconds(
  member: {
    readonly health: number;
    readonly state: string;
    readonly optimeMs: number | undefined;
  },
  primaryOptimeMs: number | undefined,
): number | undefined {
  if (
    primaryOptimeMs === undefined ||
    member.optimeMs === undefined ||
    member.optimeMs <= 0 ||
    member.health !== 1 ||
    member.state !== 'SECONDARY'
  ) {
    return undefined;
  }
  return Math.max(0, primaryOptimeMs - member.optimeMs) / 1000;
}

function normaliseMemberConfig(raw: unknown): ReplicaSetMemberConfig | undefined {
  const id = readNumber(raw, '_id');
  const host = readString(raw, 'host');
  if (id === undefined || host === undefined) {
    return undefined;
  }
  const delay = readNumber(raw, 'secondaryDelaySecs') ?? readNumber(raw, 'slaveDelay') ?? 0;
  return {
    id,
    host,
    priority: readNumber(raw, 'priority') ?? DEFAULT_PRIORITY,
    votes: readNumber(raw, 'votes') ?? DEFAULT_VOTES,
    hidden: readBoolean(raw, 'hidden') ?? false,
    arbiterOnly: readBoolean(raw, 'arbiterOnly') ?? false,
    buildIndexes: readBoolean(raw, 'buildIndexes') ?? true,
    secondaryDelaySecs: delay,
    tags: readTags(raw),
  };
}

function normaliseMember(
  raw: unknown,
  configById: ReadonlyMap<number, ReplicaSetMemberConfig>,
  primaryOptime: number | undefined,
): ReplicaSetMember | undefined {
  const id = readNumber(raw, '_id');
  const name = readString(raw, 'name');
  if (id === undefined || name === undefined) {
    return undefined;
  }
  const stateCode = readNumber(raw, 'state') ?? -1;
  const state = readString(raw, 'stateStr') ?? String(stateCode);
  const health = readNumber(raw, 'health') ?? 0;
  const optimeMs = readDateMs(raw, 'optimeDate');
  const lagSeconds = memberLagSeconds({ health, state, optimeMs }, primaryOptime);
  const config = configById.get(id) ?? { ...UNKNOWN_MEMBER_CONFIG, id, host: name };
  const syncSourceHost = readString(raw, 'syncSourceHost');
  const electionDate = readDate(raw, 'electionDate');
  const optimeDate = optimeMs === undefined ? undefined : new Date(optimeMs);
  const lastHeartbeatMessage = readString(raw, 'lastHeartbeatMessage');
  return {
    id,
    name,
    state,
    stateCode,
    health,
    ...definedField('uptimeSeconds', readNumber(raw, 'uptime')),
    ...definedField('optimeDate', optimeDate?.toISOString()),
    ...definedField('lagSeconds', lagSeconds),
    ...definedField('syncSourceHost', syncSourceHost === '' ? undefined : syncSourceHost),
    self: readBoolean(raw, 'self') === true,
    priority: config.priority,
    votes: config.votes,
    hidden: config.hidden,
    arbiterOnly: config.arbiterOnly,
    buildIndexes: config.buildIndexes,
    secondaryDelaySecs: config.secondaryDelaySecs,
    tags: config.tags,
    ...definedField('electionDate', electionDate?.toISOString()),
    ...definedField('configVersion', readNumber(raw, 'configVersion')),
    ...definedField(
      'lastHeartbeatMessage',
      lastHeartbeatMessage === '' ? undefined : lastHeartbeatMessage,
    ),
  };
}

function primaryOptimeMs(rawMembers: readonly unknown[]): number | undefined {
  const primary = rawMembers.find((member) => readString(member, 'stateStr') === 'PRIMARY');
  return readDateMs(primary, 'optimeDate');
}

function normaliseOplog(replies: RawReplicaSetReplies): ReplicaSetOplog | undefined {
  const firstSeconds = timestampSeconds(replies.oplogFirst);
  const lastSeconds = timestampSeconds(replies.oplogLast);
  if (firstSeconds === undefined || lastSeconds === undefined || lastSeconds < firstSeconds) {
    return undefined;
  }
  const maxSize = readNumber(replies.oplogStats, 'maxSize');
  const size = readNumber(replies.oplogStats, 'size');
  return {
    firstTs: secondsToIso(firstSeconds),
    lastTs: secondsToIso(lastSeconds),
    windowSeconds: lastSeconds - firstSeconds,
    ...definedField('sizeMb', maxSize === undefined ? undefined : maxSize / BYTES_PER_MB),
    ...definedField('usedMb', size === undefined ? undefined : size / BYTES_PER_MB),
  };
}

// A timestamp's seconds are unsigned. The high 32 bits are read unsigned so the window stays
// correct after 2038-01-19.
function timestampSeconds(entry: unknown): number | undefined {
  const timestamp = readField(entry, 'ts');
  const seconds = readNumber(timestamp, 't');
  if (seconds !== undefined) {
    return seconds;
  }
  const high = readNumber(timestamp, 'high');
  return high === undefined ? undefined : high >>> 0;
}

function secondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function unexpectedReply(what: string): AppErrorException {
  return new AppErrorException(
    appError('COMMAND_FAILED', `The server returned a replica set ${what} this client cannot read`),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readField(source: unknown, key: string): unknown {
  return isPlainObject(source) ? source[key] : undefined;
}

function readObject(source: unknown, key: string): Record<string, unknown> | undefined {
  const value = readField(source, key);
  return isPlainObject(value) ? value : undefined;
}

function readString(source: unknown, key: string): string | undefined {
  const value = readField(source, key);
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(source: unknown, key: string): boolean | undefined {
  const value = readField(source, key);
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(source: unknown, key: string): number | undefined {
  const value = readField(source, key);
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readDate(source: unknown, key: string): Date | undefined {
  const value = readField(source, key);
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : undefined;
}

// Epoch milliseconds of a date field, or undefined when the field is missing.
function readDateMs(source: unknown, key: string): number | undefined {
  return readDate(source, key)?.getTime();
}

function readArray(source: unknown, key: string): unknown[] {
  const value = readField(source, key);
  return Array.isArray(value) ? value : [];
}

function readTags(source: unknown): Record<string, string> {
  const tags = readObject(source, 'tags');
  if (tags === undefined) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(tags).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

// Adds a key only when the value is defined, so optional schema fields stay absent rather than
// undefined. Typed loosely because each call site supplies one key and one value.
function definedField<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
