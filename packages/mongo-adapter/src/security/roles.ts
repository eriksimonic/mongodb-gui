import type { MongoClient } from 'mongodb';
import {
  AppErrorException,
  appError,
  CreateRoleInputSchema,
  DatabaseNameSchema,
  DropRoleInputSchema,
  GrantPrivilegesInputSchema,
  GrantRolesToRoleInputSchema,
  isBuiltinRole,
  RevokePrivilegesInputSchema,
  RevokeRolesFromRoleInputSchema,
  RoleRefSchema,
  UpdateRoleInputSchema,
  type CreateRoleInput,
  type DropRoleInput,
  type GrantPrivilegesInput,
  type GrantRolesToRoleInput,
  type RevokePrivilegesInput,
  type RevokeRolesFromRoleInput,
  type RoleInfo,
  type RoleRef,
  type UpdateRoleInput,
} from '@mongo-gui/core';
import { definedEntry, readArray, readString } from '../documents';
import { parseInput, validationError } from '../management/errors';
import { runSecurityCommand } from './errors';
import {
  builtinFlag,
  optionalPrivileges,
  optionalRoleRefs,
  toPrivileges,
  toRestrictions,
  toRoleRefs,
} from './mapping';

// Lists the roles of one database, or of every database when `db` is undefined. Built-in roles
// are included so the UI can show them as read-only.
export async function listRoles(client: MongoClient, db?: string): Promise<RoleInfo[]> {
  return runSecurityCommand([], async () => {
    if (db === undefined) {
      const names = await listDatabaseNames(client);
      const replies = await Promise.all(names.map((name) => rolesInfoFor(client, name)));
      return replies.flat();
    }
    return rolesInfoFor(client, parseInput(DatabaseNameSchema, db));
  });
}

export async function getRole(
  client: MongoClient,
  db: string,
  role: string,
): Promise<RoleInfo | null> {
  return runSecurityCommand([], async () => {
    const ref: RoleRef = parseInput(RoleRefSchema, { db, role });
    const reply = await client.db(ref.db).command({
      rolesInfo: { role: ref.role, db: ref.db },
      showBuiltinRoles: true,
      showPrivileges: true,
      showAuthenticationRestrictions: true,
    });
    return readArray(reply, 'roles').flatMap(toRoleInfo)[0] ?? null;
  });
}

export async function createRole(client: MongoClient, input: unknown): Promise<RoleInfo> {
  const parsed: CreateRoleInput = parseInput(CreateRoleInputSchema, input);
  refuseBuiltin(parsed.role, 'create');
  return runSecurityCommand([], async () => {
    await client.db(parsed.db).command({
      createRole: parsed.role,
      privileges: parsed.privileges,
      roles: parsed.roles,
      ...definedEntry('authenticationRestrictions', parsed.authenticationRestrictions),
    });
    const created = await getRole(client, parsed.db, parsed.role);
    if (created === null) {
      throw new AppErrorException(
        appError('COMMAND_FAILED', 'The role was not found after it was created'),
      );
    }
    return created;
  });
}

export async function updateRole(client: MongoClient, input: unknown): Promise<void> {
  const parsed: UpdateRoleInput = parseInput(UpdateRoleInputSchema, input);
  refuseBuiltin(parsed.role, 'update');
  await runSecurityCommand([], async () => {
    await client.db(parsed.db).command({
      updateRole: parsed.role,
      ...definedEntry('privileges', parsed.privileges),
      ...definedEntry('roles', parsed.roles),
      ...definedEntry('authenticationRestrictions', parsed.authenticationRestrictions),
    });
  });
}

export async function grantPrivileges(client: MongoClient, input: unknown): Promise<void> {
  const parsed: GrantPrivilegesInput = parseInput(GrantPrivilegesInputSchema, input);
  refuseBuiltin(parsed.role, 'change');
  await runSecurityCommand([], async () => {
    await client.db(parsed.db).command({
      grantPrivilegesToRole: parsed.role,
      privileges: parsed.privileges,
    });
  });
}

export async function revokePrivileges(client: MongoClient, input: unknown): Promise<void> {
  const parsed: RevokePrivilegesInput = parseInput(RevokePrivilegesInputSchema, input);
  refuseBuiltin(parsed.role, 'change');
  await runSecurityCommand([], async () => {
    await client.db(parsed.db).command({
      revokePrivilegesFromRole: parsed.role,
      privileges: parsed.privileges,
    });
  });
}

export async function grantRolesToRole(client: MongoClient, input: unknown): Promise<void> {
  const parsed: GrantRolesToRoleInput = parseInput(GrantRolesToRoleInputSchema, input);
  refuseBuiltin(parsed.role, 'change');
  await runSecurityCommand([], async () => {
    await client.db(parsed.db).command({ grantRolesToRole: parsed.role, roles: parsed.roles });
  });
}

export async function revokeRolesFromRole(client: MongoClient, input: unknown): Promise<void> {
  const parsed: RevokeRolesFromRoleInput = parseInput(RevokeRolesFromRoleInputSchema, input);
  refuseBuiltin(parsed.role, 'change');
  await runSecurityCommand([], async () => {
    await client.db(parsed.db).command({ revokeRolesFromRole: parsed.role, roles: parsed.roles });
  });
}

// Dropping a role also removes it from the users and roles that hold it, as the server does.
export async function dropRole(client: MongoClient, input: unknown): Promise<void> {
  const parsed: DropRoleInput = parseInput(DropRoleInputSchema, input);
  refuseBuiltin(parsed.role, 'drop');
  await runSecurityCommand([], async () => {
    await client.db(parsed.db).command({ dropRole: parsed.role });
  });
}

function refuseBuiltin(role: string, action: string): void {
  if (isBuiltinRole(role)) {
    throw validationError(`Refusing to ${action} the built-in role ${role}`);
  }
}

async function rolesInfoFor(client: MongoClient, db: string): Promise<RoleInfo[]> {
  const reply = await client.db(db).command({
    rolesInfo: 1,
    showBuiltinRoles: true,
    showPrivileges: true,
    showAuthenticationRestrictions: true,
  });
  return readArray(reply, 'roles').flatMap(toRoleInfo);
}

async function listDatabaseNames(client: MongoClient): Promise<string[]> {
  const reply = await client.db('admin').command({ listDatabases: 1, nameOnly: true });
  return readArray(reply, 'databases').flatMap((item) => {
    const name = readString(item, 'name');
    return name === undefined ? [] : [name];
  });
}

function toRoleInfo(source: unknown): RoleInfo[] {
  const role = readString(source, 'role');
  const db = readString(source, 'db');
  if (role === undefined || db === undefined) {
    return [];
  }
  return [
    {
      id: `${db}.${role}`,
      role,
      db,
      isBuiltin: builtinFlag(source, role),
      roles: toRoleRefs(source, 'roles'),
      privileges: toPrivileges(source, 'privileges'),
      authenticationRestrictions: toRestrictions(source, 'authenticationRestrictions'),
      ...definedEntry('inheritedRoles', optionalRoleRefs(source, 'inheritedRoles')),
      ...definedEntry('inheritedPrivileges', optionalPrivileges(source, 'inheritedPrivileges')),
    },
  ];
}
