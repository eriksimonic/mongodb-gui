import type { MongoClient } from 'mongodb';
import {
  AuthStatusSchema,
  DatabaseNameSchema,
  type AuthStatus,
  type Privilege,
} from '@mongo-gui/core';
import { readArray, readField, readString } from '../documents';
import { parseInput } from '../management/errors';
import { runSecurityCommand } from './errors';
import { toPrivileges, toRoleRefs } from './mapping';

// Roles that let the holder create and grant users on every database.
const USER_ADMIN_ROLES: ReadonlySet<string> = new Set(['root', 'userAdminAnyDatabase']);
// Privileges that allow managing users. `anyAction` covers every action, including these.
const USER_ADMIN_ACTIONS: ReadonlySet<string> = new Set(['createUser', 'grantRole', 'anyAction']);

// Returns the users authenticated on this connection, with their roles and privileges.
export async function connectionStatus(client: MongoClient): Promise<AuthStatus> {
  return runSecurityCommand([], async () => {
    const reply = await client.db('admin').command({ connectionStatus: 1, showPrivileges: true });
    const authInfo = readField(reply, 'authInfo');
    const status: AuthStatus = {
      authenticatedUsers: readArray(authInfo, 'authenticatedUsers').flatMap((item) => {
        const user = readString(item, 'user');
        const db = readString(item, 'db');
        return user === undefined || db === undefined ? [] : [{ user, db }];
      }),
      authenticatedUserRoles: toRoleRefs(authInfo, 'authenticatedUserRoles'),
      authenticatedUserPrivileges: toPrivileges(authInfo, 'authenticatedUserPrivileges'),
    };
    return AuthStatusSchema.parse(status);
  });
}

// True when the authenticated user may manage users on `db`. Used to hide the controls the
// server would refuse anyway. The server still enforces the rule on every command.
export async function canManageUsers(client: MongoClient, db: string): Promise<boolean> {
  const database = parseInput(DatabaseNameSchema, db);
  const status = await connectionStatus(client);
  const hasRole = status.authenticatedUserRoles.some((ref) => USER_ADMIN_ROLES.has(ref.role));
  return (
    hasRole ||
    status.authenticatedUserPrivileges.some((privilege) => grantsUserAdmin(privilege, database))
  );
}

function grantsUserAdmin(privilege: Privilege, db: string): boolean {
  const { resource, actions } = privilege;
  if (!actions.some((action) => USER_ADMIN_ACTIONS.has(action))) {
    return false;
  }
  if ('anyResource' in resource) {
    return true;
  }
  return 'db' in resource && (resource.db === db || resource.db === '');
}
