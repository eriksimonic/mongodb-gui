import type { MongoClient } from 'mongodb';
import {
  AuthStatusSchema,
  DatabaseNameSchema,
  type AuthStatus,
  type Privilege,
  type UserManagementCapabilities,
} from '@mongo-gui/core';
import { readArray, readField, readString } from '../documents';
import { parseInput } from '../management/errors';
import { parseServerRecord, runSecurityCommand } from './errors';
import { toPrivileges, toRoleRefs } from './mapping';

// Built-in roles that grant every user and role action. The check counts only the copies on
// the admin database, which is where the built-in roles live.
const ADMIN_ROLES: ReadonlySet<string> = new Set(['root', 'userAdminAnyDatabase']);
const ADMIN_DATABASE = 'admin';
// `anyAction` matches every action, so it also covers the actions named below.
const ANY_ACTION = 'anyAction';

const CREATE_USER_ACTIONS: ReadonlySet<string> = new Set(['createUser', ANY_ACTION]);
const GRANT_ROLE_ACTIONS: ReadonlySet<string> = new Set(['grantRole', ANY_ACTION]);
const MANAGE_ROLE_ACTIONS: ReadonlySet<string> = new Set(['createRole', 'dropRole', ANY_ACTION]);

// Returns the users authenticated on this connection, with their roles and privileges.
export async function connectionStatus(client: MongoClient): Promise<AuthStatus> {
  return runSecurityCommand([], async () => {
    const reply = await client.db('admin').command({ connectionStatus: 1, showPrivileges: true });
    const authInfo = readField(reply, 'authInfo');
    const candidate = {
      authenticatedUsers: readArray(authInfo, 'authenticatedUsers').flatMap((item) => {
        const user = readString(item, 'user');
        const db = readString(item, 'db');
        return user === undefined || db === undefined ? [] : [{ user, db }];
      }),
      authenticatedUserRoles: toRoleRefs(authInfo, 'authenticatedUserRoles'),
      authenticatedUserPrivileges: toPrivileges(authInfo, 'authenticatedUserPrivileges'),
    };
    return parseServerRecord(AuthStatusSchema, candidate, 'connection status');
  });
}

// Reports which user and role controls the authenticated user may use on `db`. Controls the
// user cannot use are hidden. The server still refuses the command if the flag is wrong.
export async function userManagementCapabilities(
  client: MongoClient,
  db: string,
): Promise<UserManagementCapabilities> {
  const database = parseInput(DatabaseNameSchema, db);
  const status = await connectionStatus(client);
  const hasAdminRole = status.authenticatedUserRoles.some(
    (ref) => ref.db === ADMIN_DATABASE && ADMIN_ROLES.has(ref.role),
  );
  const grants = (actions: ReadonlySet<string>): boolean =>
    hasAdminRole ||
    status.authenticatedUserPrivileges.some((privilege) => grantsOn(privilege, database, actions));
  return {
    canCreateUsers: grants(CREATE_USER_ACTIONS),
    canGrantRoles: grants(GRANT_ROLE_ACTIONS),
    canManageRoles: grants(MANAGE_ROLE_ACTIONS),
  };
}

function grantsOn(privilege: Privilege, db: string, actions: ReadonlySet<string>): boolean {
  if (!privilege.actions.some((action) => actions.has(action))) {
    return false;
  }
  const { resource } = privilege;
  if ('anyResource' in resource) {
    return true;
  }
  return 'db' in resource && 'collection' in resource && (resource.db === db || resource.db === '');
}
