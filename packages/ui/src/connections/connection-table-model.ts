import type { ConnectionProfileSummary } from '@mongo-gui/core';

export type ConnectionColumn = 'name' | 'server' | 'security' | 'color' | 'lastAccessed';

export interface ConnectionSort {
  readonly column: ConnectionColumn;
  readonly direction: 'asc' | 'desc';
}

export type ConnectionFilters = Readonly<Record<ConnectionColumn, string>>;

export const EMPTY_FILTERS: ConnectionFilters = {
  name: '',
  server: '',
  security: '',
  color: '',
  lastAccessed: '',
};

export const DEFAULT_CONNECTION_SORT: ConnectionSort = {
  column: 'lastAccessed',
  direction: 'desc',
};

const SCHEME = /^mongodb(\+srv)?:\/\//i;

/** The user name in a redacted URI, or undefined when it has none. */
function userOf(uri: string): string | undefined {
  const match = /^mongodb(?:\+srv)?:\/\/([^:@/?]+)(?::[^@/?]*)?@/i.exec(uri);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

function optionOf(uri: string, name: string): string | undefined {
  const query = uri.split('?')[1];
  if (query === undefined) {
    return undefined;
  }
  for (const pair of query.split('&')) {
    const [key, value] = pair.split('=');
    if (key?.toLowerCase() === name.toLowerCase() && value !== undefined) {
      return decodeURIComponent(value);
    }
  }
  return undefined;
}

/** The hosts of a redacted URI. A +srv URI keeps its scheme, because its host is a DNS name. */
export function serverText(connection: ConnectionProfileSummary): string {
  const uri = connection.uriRedacted;
  const rest = uri.replace(SCHEME, '');
  const authorityEnd = rest.search(/[/?]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const hosts = authority.slice(authority.lastIndexOf('@') + 1);
  return /^mongodb\+srv:\/\//i.test(uri) ? `mongodb+srv://${hosts}` : hosts;
}

/**
 * How the connection authenticates, in the style of NoSQLBooster: tags for TLS and a special
 * mechanism, then the user and the authentication database.
 */
export function securityText(connection: ConnectionProfileSummary): string {
  const uri = connection.uriRedacted;
  const tags: string[] = [];
  if (connection.tls?.enabled === true || optionOf(uri, 'tls') === 'true') {
    tags.push('[SSL]');
  }
  const mechanism = optionOf(uri, 'authMechanism');
  if (mechanism !== undefined && !mechanism.startsWith('SCRAM')) {
    tags.push(`[${mechanism.replace('MONGODB-', '')}]`);
  }
  const user = userOf(uri);
  const database = optionOf(uri, 'authSource') ?? (user === undefined ? undefined : 'admin');
  const who = user === undefined ? '' : `${user} @ ${database ?? 'admin'}`;
  return [...tags, who].filter((part) => part !== '').join(' ');
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

/** "just now", "5 min ago", "3 h ago", "6 days ago" or "2 months ago". Never when it was not set. */
export function formatAge(iso: string | undefined, now: number = Date.now()): string {
  if (iso === undefined) {
    return 'Never';
  }
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return iso;
  }
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < MINUTE) {
    return 'just now';
  }
  if (seconds < HOUR) {
    return `${Math.floor(seconds / MINUTE)} min ago`;
  }
  if (seconds < DAY) {
    return `${Math.floor(seconds / HOUR)} h ago`;
  }
  const days = Math.floor(seconds / DAY);
  if (days < 30) {
    return days === 1 ? '1 day ago' : `${days} days ago`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return months === 1 ? '1 month ago' : `${months} months ago`;
  }
  const years = Math.floor(days / 365);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

function textOf(connection: ConnectionProfileSummary, column: ConnectionColumn): string {
  switch (column) {
    case 'name':
      return connection.name;
    case 'server':
      return serverText(connection);
    case 'security':
      return securityText(connection);
    case 'color':
      return connection.color ?? '';
    case 'lastAccessed':
      return formatAge(connection.lastAccessedAt);
  }
}

/** The rows that match every non-empty filter as a case-insensitive substring, in sort order. */
export function visibleConnections(
  connections: readonly ConnectionProfileSummary[],
  filters: ConnectionFilters,
  sort: ConnectionSort,
): ConnectionProfileSummary[] {
  const active = (Object.keys(filters) as ConnectionColumn[]).filter(
    (column) => filters[column].trim() !== '',
  );
  const matching = connections.filter((connection) =>
    active.every((column) =>
      textOf(connection, column).toLowerCase().includes(filters[column].trim().toLowerCase()),
    ),
  );
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...matching].sort((left, right) => {
    if (sort.column === 'lastAccessed') {
      // Never sorts as the oldest, so it ends last in a newest-first list.
      return sign * (left.lastAccessedAt ?? '').localeCompare(right.lastAccessedAt ?? '');
    }
    return sign * textOf(left, sort.column).localeCompare(textOf(right, sort.column));
  });
}
