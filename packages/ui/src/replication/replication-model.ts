import type {
  AppError,
  ReplicaSetConfig,
  ReplicaSetMember,
  ReplicaSetStatus,
} from '@mongo-gui/core';

const NOT_INITIALISED_CODE_NAME = 'NotYetInitialized';
const NO_REPLICATION_CODE_NAME = 'NoReplicationEnabled';

/** What a member's state means to a reader. The colour follows from it. */
export type MemberMeaning = 'primary' | 'secondary' | 'arbiter' | 'recovering' | 'down';

export const MEMBER_MEANING_COLOUR: Readonly<Record<MemberMeaning, string>> = {
  primary: 'blue',
  secondary: 'violet',
  arbiter: 'gray',
  recovering: 'yellow',
  down: 'red',
};

const MEMBER_MEANING_LABEL: Readonly<Record<MemberMeaning, string>> = {
  primary: 'Primary',
  secondary: 'Secondary',
  arbiter: 'Arbiter',
  recovering: 'Recovering',
  down: 'Down',
};

const RECOVERING_STATES: readonly string[] = [
  'RECOVERING',
  'STARTUP',
  'STARTUP2',
  'ROLLBACK',
  'REMOVED',
];

/**
 * The meaning of a member. An unhealthy member is down whatever its last reported state. An
 * arbiter is shown as an arbiter, not as a secondary, even though it is healthy.
 */
export function memberMeaning(member: Pick<ReplicaSetMember, 'state' | 'health'>): MemberMeaning {
  if (member.health !== 1 || member.state === 'DOWN' || member.state === 'UNKNOWN') {
    return 'down';
  }
  if (member.state === 'PRIMARY') {
    return 'primary';
  }
  if (member.state === 'ARBITER') {
    return 'arbiter';
  }
  if (RECOVERING_STATES.includes(member.state)) {
    return 'recovering';
  }
  return 'secondary';
}

export function memberMeaningLabel(meaning: MemberMeaning): string {
  return MEMBER_MEANING_LABEL[meaning];
}

/**
 * A lag as a duration. Sub-minute lags keep a decimal, so a 2.5 second lag reads as 2.5 s. Longer
 * lags show whole units.
 */
export function formatLag(seconds: number | undefined): string {
  if (seconds === undefined) {
    return '–';
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }
  return formatDuration(Math.round(seconds));
}

/** Whole seconds as a duration in hours, minutes and seconds, leaving out zero leading units. */
export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours} h ${minutes} min`;
  }
  if (minutes > 0) {
    return `${minutes} min ${seconds} s`;
  }
  return `${seconds} s`;
}

/** An instant as "now", "N s ago", "N min ago" or "N h ago" relative to `nowMs`. */
export function formatAgo(iso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (seconds < 2) {
    return 'now';
  }
  if (seconds < 60) {
    return `${seconds} s ago`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} min ago`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)} h ago`;
  }
  return `${Math.floor(seconds / 86400)} d ago`;
}

/** The members that count as healthy, and the votes a majority needs. */
export function memberCounts(status: ReplicaSetStatus): { healthy: number; majority: number } {
  const voting = status.members.filter((member) => member.votes > 0).length;
  return {
    healthy: status.members.filter((member) => member.health === 1).length,
    majority: status.majorityVoteCount ?? Math.floor(voting / 2) + 1,
  };
}

/** The secondaries that can take over from the primary: healthy, voting and above priority 0. */
export function electableSecondaries(status: ReplicaSetStatus): ReplicaSetMember[] {
  return status.members.filter(
    (member) =>
      memberMeaning(member) === 'secondary' &&
      member.priority > 0 &&
      member.votes > 0 &&
      !member.hidden &&
      member.secondaryDelaySecs === 0,
  );
}

export interface ElectionEvent {
  readonly at: string;
  readonly summary: string;
  readonly term?: number;
}

/**
 * Elections the status reports, newest first. The members carry the election date of the primary
 * they elected. The candidate metrics add the reason and term of the last election when the server
 * reports them. The metrics are opaque in core, so only known string and number fields are read.
 */
export function electionEvents(status: ReplicaSetStatus): ElectionEvent[] {
  const events: ElectionEvent[] = [];
  for (const member of status.members) {
    if (member.electionDate !== undefined) {
      events.push({
        at: member.electionDate,
        summary: `${member.name} became primary`,
        ...(status.term === undefined ? {} : { term: status.term }),
      });
    }
  }
  const metrics = status.electionCandidateMetrics;
  if (isRecord(metrics) && typeof metrics['lastElectionDate'] === 'string') {
    const reason =
      typeof metrics['lastElectionReason'] === 'string'
        ? ` after ${metrics['lastElectionReason']}`
        : '';
    events.push({
      at: metrics['lastElectionDate'],
      summary: `Election${reason}`,
      ...(typeof metrics['termAtLastElection'] === 'number'
        ? { term: metrics['termAtLastElection'] }
        : {}),
    });
  }
  return events.sort((left, right) => right.at.localeCompare(left.at));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * True when the server reports that the node has no replica set configuration. The server's error
 * name decides. The wording of the detail is the fallback for an error without a name.
 */
export function isUninitiatedError(error: AppError | undefined): boolean {
  if (error === undefined) {
    return false;
  }
  return (
    error.codeName === NOT_INITIALISED_CODE_NAME || /no replset config/i.test(error.detail ?? '')
  );
}

/** True when the server is running without --replSet, so it has no set to show. */
export function isNoReplicationError(error: AppError | undefined): boolean {
  if (error === undefined) {
    return false;
  }
  return (
    error.codeName === NO_REPLICATION_CODE_NAME ||
    /not running with --replSet/i.test(error.detail ?? '')
  );
}

/** Key and value rows the tags editor works with. Rows with an empty key are dropped on save. */
export interface TagRow {
  readonly key: string;
  readonly value: string;
}

export function tagsToRows(tags: Readonly<Record<string, string>>): TagRow[] {
  return Object.entries(tags).map(([key, value]) => ({ key, value }));
}

export function rowsToTags(rows: readonly TagRow[]): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key !== '') {
      tags[key] = row.value;
    }
  }
  return tags;
}

/** The first duplicate key in the tag rows, if any. The server keeps the last one, so refuse it. */
export function duplicateTagKey(rows: readonly TagRow[]): string | undefined {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key === '') {
      continue;
    }
    if (seen.has(key)) {
      return key;
    }
    seen.add(key);
  }
  return undefined;
}

/** A piece of the change preview and how to colour it. */
export interface DiffToken {
  readonly text: string;
  readonly kind: 'plain' | 'key' | 'string' | 'number';
}

const MEMBER_FIELDS = [
  'priority',
  'votes',
  'hidden',
  'arbiterOnly',
  'buildIndexes',
  'secondaryDelaySecs',
  'tags',
] as const;

const MEMBER_DEFAULTS: Readonly<Record<(typeof MEMBER_FIELDS)[number], unknown>> = {
  priority: 1,
  votes: 1,
  hidden: false,
  arbiterOnly: false,
  buildIndexes: true,
  secondaryDelaySecs: 0,
  tags: {},
};

function valueToken(value: unknown): DiffToken {
  if (typeof value === 'number') {
    return { text: String(value), kind: 'number' };
  }
  if (typeof value === 'string') {
    return { text: JSON.stringify(value), kind: 'string' };
  }
  return { text: JSON.stringify(value), kind: 'plain' };
}

/**
 * The change preview as lines of tokens: one line per added, removed or changed member, then the
 * version bump. It compares the two configurations, so it shows what the server will store.
 */
export function configDiff(current: ReplicaSetConfig, next: ReplicaSetConfig): DiffToken[][] {
  const lines: DiffToken[][] = [];
  const before = new Map(current.members.map((member) => [member.id, member]));
  const kept = new Set<number>();
  next.members.forEach((member, index) => {
    const old = before.get(member.id);
    const path: DiffToken = { text: `members[${index}]`, kind: 'plain' };
    if (old === undefined) {
      const fields = MEMBER_FIELDS.filter(
        (field) => JSON.stringify(member[field]) !== JSON.stringify(MEMBER_DEFAULTS[field]),
      );
      const body: DiffToken[] = [{ text: ' + { ', kind: 'plain' }, ...pair('host', member.host)];
      for (const field of fields) {
        body.push({ text: ', ', kind: 'plain' }, ...pair(field, member[field]));
      }
      lines.push([path, ...body, { text: ' }', kind: 'plain' }]);
      return;
    }
    kept.add(member.id);
    for (const field of MEMBER_FIELDS) {
      if (JSON.stringify(old[field]) !== JSON.stringify(member[field])) {
        lines.push([
          { text: `${path.text}.`, kind: 'plain' },
          { text: field, kind: 'key' },
          { text: '  ', kind: 'plain' },
          valueToken(old[field]),
          { text: ' → ', kind: 'plain' },
          valueToken(member[field]),
        ]);
      }
    }
  });
  for (const member of current.members) {
    if (!kept.has(member.id) && !next.members.some((item) => item.id === member.id)) {
      lines.push([
        { text: `members[${member.id}] − { `, kind: 'plain' },
        ...pair('host', member.host),
        { text: ' }', kind: 'plain' },
      ]);
    }
  }
  lines.push([
    { text: 'version  ', kind: 'plain' },
    valueToken(current.version),
    { text: ' → ', kind: 'plain' },
    valueToken(next.version),
  ]);
  return lines;
}

function pair(key: string, value: unknown): DiffToken[] {
  return [{ text: key, kind: 'key' }, { text: ': ', kind: 'plain' }, valueToken(value)];
}
