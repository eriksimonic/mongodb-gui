import type { MongoClient } from 'mongodb';
import {
  AppErrorException,
  appError,
  ChangePasswordInputSchema,
  CreateUserInputSchema,
  DropUserInputSchema,
  GrantRolesInputSchema,
  RevokeRolesInputSchema,
  UpdateUserRestrictionsInputSchema,
  UserDatabaseSchema,
  UserInfoSchema,
  UserRefSchema,
  type ChangePasswordInput,
  type CreateUserInput,
  type DropUserInput,
  type GrantRolesInput,
  type RevokeRolesInput,
  type UpdateUserRestrictionsInput,
  type UserInfo,
  type UserRef,
} from '@mongo-gui/core';
import { definedEntry, readArray, readField, readString, readStringArray } from '../documents';
import { parseInput } from '../management/errors';
import { mapWithConcurrency } from './concurrency';
import { parseServerRecord, runSecurityCommand } from './errors';
import { optionalPrivileges, optionalRoleRefs, toRestrictions, toRoleRefs } from './mapping';

// Users are read one at a time through an exact match, with this many reads in flight.
const DETAIL_CONCURRENCY = 8;

// The server refuses showPrivileges and showAuthenticationRestrictions on list queries. Those
// flags work only on an exact match of one user, so the list is read first and each user is
// then read again with its exact name. Credentials are never requested.
export async function listUsers(client: MongoClient, db?: string): Promise<UserInfo[]> {
  return runSecurityCommand([], async () => {
    const reply =
      db === undefined
        ? await client
            .db('admin')
            .command({ usersInfo: { forAllDBs: true }, showCredentials: false })
        : await client
            .db(parseInput(UserDatabaseSchema, db))
            .command({ usersInfo: 1, showCredentials: false });
    const listed = readArray(reply, 'users').map((source) => toUserInfo(source));
    return mapWithConcurrency(listed, DETAIL_CONCURRENCY, async (user) => {
      return (await readUserDetail(client, user.db, user.user)) ?? user;
    });
  });
}

// Reads one user with inherited roles, inherited privileges and authentication restrictions.
export async function getUser(
  client: MongoClient,
  db: string,
  user: string,
): Promise<UserInfo | null> {
  return runSecurityCommand([], async () => {
    const ref: UserRef = parseInput(UserRefSchema, { db, user });
    return readUserDetail(client, ref.db, ref.user);
  });
}

export async function createUser(client: MongoClient, input: unknown): Promise<UserInfo> {
  const parsed: CreateUserInput = parseInput(CreateUserInputSchema, input);
  const secrets = parsed.password === undefined ? [] : [parsed.password];
  return runSecurityCommand(secrets, async () => {
    await client.db(parsed.db).command({
      createUser: parsed.user,
      ...definedEntry('pwd', parsed.password),
      roles: parsed.roles,
      ...definedEntry('mechanisms', parsed.mechanisms),
      ...definedEntry('authenticationRestrictions', parsed.authenticationRestrictions),
      ...definedEntry('customData', parsed.customData),
    });
    const created = await getUser(client, parsed.db, parsed.user);
    if (created === null) {
      throw new AppErrorException(
        appError('COMMAND_FAILED', 'The user was not found after it was created'),
      );
    }
    return created;
  });
}

export async function changePassword(client: MongoClient, input: unknown): Promise<void> {
  const parsed: ChangePasswordInput = parseInput(ChangePasswordInputSchema, input);
  await runSecurityCommand([parsed.password], async () => {
    await client.db(parsed.db).command({ updateUser: parsed.user, pwd: parsed.password });
  });
}

export async function grantRoles(client: MongoClient, input: unknown): Promise<void> {
  const parsed: GrantRolesInput = parseInput(GrantRolesInputSchema, input);
  await runSecurityCommand([], async () => {
    await client.db(parsed.db).command({ grantRolesToUser: parsed.user, roles: parsed.roles });
  });
}

export async function revokeRoles(client: MongoClient, input: unknown): Promise<void> {
  const parsed: RevokeRolesInput = parseInput(RevokeRolesInputSchema, input);
  await runSecurityCommand([], async () => {
    await client.db(parsed.db).command({ revokeRolesFromUser: parsed.user, roles: parsed.roles });
  });
}

export async function updateUserRestrictions(client: MongoClient, input: unknown): Promise<void> {
  const parsed: UpdateUserRestrictionsInput = parseInput(UpdateUserRestrictionsInputSchema, input);
  await runSecurityCommand([], async () => {
    await client.db(parsed.db).command({
      updateUser: parsed.user,
      authenticationRestrictions: parsed.authenticationRestrictions,
    });
  });
}

export async function dropUser(client: MongoClient, input: unknown): Promise<void> {
  const parsed: DropUserInput = parseInput(DropUserInputSchema, input);
  await runSecurityCommand([], async () => {
    await client.db(parsed.db).command({ dropUser: parsed.user });
  });
}

async function readUserDetail(
  client: MongoClient,
  db: string,
  user: string,
): Promise<UserInfo | null> {
  const reply = await client.db(db).command({
    usersInfo: { user, db },
    showCredentials: false,
    showPrivileges: true,
    showAuthenticationRestrictions: true,
  });
  const source = readArray(reply, 'users')[0];
  return source === undefined ? null : toUserInfo(source);
}

function toUserInfo(source: unknown): UserInfo {
  const user = readString(source, 'user');
  const db = readString(source, 'db');
  const candidate = {
    id: `${db ?? ''}.${user ?? ''}`,
    user,
    db,
    roles: toRoleRefs(source, 'roles'),
    mechanisms: readStringArray(source, 'mechanisms'),
    authenticationRestrictions: toRestrictions(source, 'authenticationRestrictions'),
    ...definedEntry('customData', readField(source, 'customData')),
    ...definedEntry('inheritedRoles', optionalRoleRefs(source, 'inheritedRoles')),
    ...definedEntry('inheritedPrivileges', optionalPrivileges(source, 'inheritedPrivileges')),
  };
  return parseServerRecord(UserInfoSchema, candidate, 'user');
}
