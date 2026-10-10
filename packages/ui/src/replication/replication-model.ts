import type { AppError, ReplicaSetMember, ReplicaSetStatus } from '@mongo-gui/core';

/** What a member's state means to a reader. The colour follows from it. */
export type MemberMeaning = 'primary' | 'secondary' | 'arbiter' | 'recovering' | 'down';

export const MEMBER_MEANING_COLOUR: Readonly<Record<MemberMeaning, string>> = {
  primary: 'green',
  secondary: 'blue',
  arbiter: 'violet',
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

/** The oplog window in the header, with the configured size when the status reports it. */
export function oplogWindowLabel(status: ReplicaSetStatus): string {
  const oplog = status.oplog;
  if (oplog === undefined) {
    return 'Unknown';
  }
  const window = formatDuration(Math.round(oplog.windowSeconds));
  return oplog.sizeMb === undefined ? window : `${window} of ${oplog.sizeMb} MB`;
}

export interface ElectionEvent {
  readonly at: string;
  readonly summary: string;
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
        summary: `${member.name} became primary${termText(status.term)}`,
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
      summary: `Last election${reason}${termText(metrics['termAtLastElection'])}`,
    });
  }
  return events.sort((left, right) => right.at.localeCompare(left.at));
}

function termText(term: unknown): string {
  return typeof term === 'number' ? ` (term ${term})` : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * True when the server reports that the node has no replica set configuration. The adapter passes
 * the driver's text through as the detail, so the match is on the server's wording.
 */
export function isUninitiatedError(error: AppError | undefined): boolean {
  return error !== undefined && /no replset config/i.test(error.detail ?? '');
}

/** True when the server is running without --replSet, so it has no set to show. */
export function isNoReplicationError(error: AppError | undefined): boolean {
  return error !== undefined && /not running with --replSet/i.test(error.detail ?? '');
}

/** The host a new set starts with: the one the connection points at. */
export function connectionHost(hosts: readonly string[]): string {
  return hosts[0] ?? 'localhost:27017';
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
