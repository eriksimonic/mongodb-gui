import type { ConnectionStatus, UserInfo } from '@mongo-gui/core';

/** Stands in for the password, which the server never returns. */
export const PASSWORD_PLACEHOLDER = '<password>';
const FALLBACK_HOST = 'localhost:27017';

/**
 * A connection string that logs in as `user`. The hosts come from the connected status, the
 * password is a placeholder to replace, and `authSource` is the database that holds the user. A
 * replica set connection keeps its set name; a direct connection keeps `directConnection=true`.
 */
export function userConnectionString(
  user: Pick<UserInfo, 'user' | 'db'>,
  status: ConnectionStatus | undefined,
): string {
  const connected = status?.state === 'connected' ? status : undefined;
  const hosts =
    connected !== undefined && connected.hosts.length > 0 ? connected.hosts : [FALLBACK_HOST];
  const options = [`authSource=${encodeURIComponent(user.db)}`];
  if (connected?.directConnection === true) {
    options.push('directConnection=true');
  } else if (connected?.setName !== undefined) {
    options.push(`replicaSet=${encodeURIComponent(connected.setName)}`);
  }
  const credentials = `${encodeURIComponent(user.user)}:${PASSWORD_PLACEHOLDER}`;
  return `mongodb://${credentials}@${hosts.join(',')}/?${options.join('&')}`;
}
