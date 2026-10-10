import {
  BUILTIN_ROLES,
  isBuiltinRole,
  privilegeActionCatalog,
  rpcContract,
  type Privilege,
  type RoleInfo,
  type RpcClient,
  type UserInfo,
  type UserRoleRef,
} from '@mongo-gui/core';
import { fail, method } from './mock-support';

/** The users and custom roles one mock connection holds. Built-in roles are added by the calls. */
export interface MockSecurity {
  users: UserInfo[];
  roles: RoleInfo[];
}

export interface MockSecurityContext {
  readonly latencyMs: number;
  /** True for a signed-in user with no user or role rights. Every capability then reads false. */
  readonly viewer?: boolean | undefined;
  /** Throws unless the vault is unlocked and the connection is connected. */
  guard(connectionId: string): void;
  securityOf(connectionId: string): MockSecurity;
}

function roleRef(role: string, db: string): UserRoleRef {
  return { role, db };
}

/** Two users, one in a normal database and one in $external, and a custom role on one of them. */
export function fixtureSecurity(): MockSecurity {
  const analystPrivileges: Privilege[] = [
    { resource: { db: 'shop', collection: 'orders' }, actions: ['find', 'listIndexes'] },
    { resource: { db: 'shop', collection: '' }, actions: ['listCollections'] },
  ];
  return {
    users: [
      {
        id: 'admin.siteAdmin',
        user: 'siteAdmin',
        db: 'admin',
        roles: [roleRef('userAdminAnyDatabase', 'admin'), roleRef('readWriteAnyDatabase', 'admin')],
        mechanisms: ['SCRAM-SHA-256'],
        authenticationRestrictions: [],
      },
      {
        id: 'shop.reporter',
        user: 'reporter',
        db: 'shop',
        roles: [roleRef('analyst', 'shop')],
        mechanisms: ['SCRAM-SHA-256', 'SCRAM-SHA-1'],
        authenticationRestrictions: [{ clientSource: ['10.0.0.0/8'] }],
      },
    ],
    roles: [
      {
        id: 'shop.analyst',
        role: 'analyst',
        db: 'shop',
        isBuiltin: false,
        roles: [roleRef('read', 'shop')],
        privileges: analystPrivileges,
        authenticationRestrictions: [],
      },
    ],
  };
}

/**
 * Every built-in role, listed under the database it is granted on, as the server lists them. The
 * mock gives them no privileges of their own.
 */
function builtinRoles(db: string): RoleInfo[] {
  return Object.values(BUILTIN_ROLES)
    .flatMap((names) => names)
    .map((role) => ({
      id: `${db}.${role}`,
      role,
      db,
      isBuiltin: true,
      roles: [],
      privileges: [],
      authenticationRestrictions: [],
    }));
}

/** The user the mock connection signs in as. It holds both user admin roles on admin. */
const SIGNED_IN_USER = { user: 'siteAdmin', db: 'admin' } as const;
const SIGNED_IN_ROLES: UserRoleRef[] = [
  roleRef('userAdminAnyDatabase', 'admin'),
  roleRef('readWriteAnyDatabase', 'admin'),
];

/** A role may not inherit itself. The server refuses it, so the mock does too. */
function refuseSelfInheritance(role: string, db: string, roles: readonly UserRoleRef[]): void {
  if (roles.some((ref) => ref.role === role && ref.db === db)) {
    throw fail('COMMAND_FAILED', 'A role cannot inherit itself', `${role}@${db}`);
  }
}

function sameRef(left: UserRoleRef, right: UserRoleRef): boolean {
  return left.role === right.role && left.db === right.db;
}

function userId(db: string, user: string): string {
  return `${db}.${user}`;
}

function findUser(security: MockSecurity, db: string, user: string): UserInfo {
  const found = security.users.find((item) => item.db === db && item.user === user);
  if (found === undefined) {
    throw fail('COMMAND_FAILED', 'User not found', `${user}@${db}`);
  }
  return found;
}

function findCustomRole(security: MockSecurity, db: string, role: string): RoleInfo | undefined {
  return security.roles.find((item) => item.db === db && item.role === role);
}

function requireKnownRoles(security: MockSecurity, roles: readonly UserRoleRef[]): void {
  for (const ref of roles) {
    const known =
      isBuiltinRole(ref.role) || findCustomRole(security, ref.db, ref.role) !== undefined;
    if (!known) {
      throw fail('COMMAND_FAILED', 'Role not found', `${ref.role}@${ref.db}`);
    }
  }
}

function refuseBuiltin(role: string, action: string): void {
  if (isBuiltinRole(role)) {
    throw fail('VALIDATION', `Refusing to ${action} the built-in role ${role}`);
  }
}

/** The security calls of the mock, with the same input and output contract as the router. */
export function createSecurityCalls(context: MockSecurityContext): RpcClient['security'] {
  const { latencyMs } = context;
  const calls = rpcContract.security;
  const viewer = context.viewer === true;

  return {
    session: method(calls.session, latencyMs, ({ connectionId }) => {
      context.guard(connectionId);
      return {
        authenticatedUsers: [{ ...SIGNED_IN_USER }],
        authenticatedUserRoles: SIGNED_IN_ROLES.map((ref) => ({ ...ref })),
        authenticatedUserPrivileges: [],
      };
    }),

    listUsers: method(calls.listUsers, latencyMs, ({ connectionId, database }) => {
      context.guard(connectionId);
      return context
        .securityOf(connectionId)
        .users.filter((user) => user.db === database)
        .sort((left, right) => left.user.localeCompare(right.user));
    }),

    createUser: method(calls.createUser, latencyMs, (input) => {
      context.guard(input.connectionId);
      const security = context.securityOf(input.connectionId);
      if (security.users.some((user) => user.db === input.db && user.user === input.user)) {
        throw fail('COMMAND_FAILED', 'User already exists', `${input.user}@${input.db}`);
      }
      requireKnownRoles(security, input.roles);
      const created: UserInfo = {
        id: userId(input.db, input.user),
        user: input.user,
        db: input.db,
        roles: input.roles.map((ref) => roleRef(ref.role, ref.db)),
        mechanisms: input.mechanisms ?? ['SCRAM-SHA-256'],
        authenticationRestrictions: input.authenticationRestrictions ?? [],
        ...(input.customData === undefined ? {} : { customData: input.customData }),
      };
      security.users.push(created);
      return created;
    }),

    changePassword: method(calls.changePassword, latencyMs, (input) => {
      context.guard(input.connectionId);
      findUser(context.securityOf(input.connectionId), input.db, input.user);
    }),

    grantRoles: method(calls.grantRoles, latencyMs, (input) => {
      context.guard(input.connectionId);
      const security = context.securityOf(input.connectionId);
      const user = findUser(security, input.db, input.user);
      requireKnownRoles(security, input.roles);
      const added = input.roles.filter((ref) => !user.roles.some((held) => sameRef(held, ref)));
      user.roles = [...user.roles, ...added.map((ref) => roleRef(ref.role, ref.db))];
    }),

    revokeRoles: method(calls.revokeRoles, latencyMs, (input) => {
      context.guard(input.connectionId);
      const user = findUser(context.securityOf(input.connectionId), input.db, input.user);
      user.roles = user.roles.filter((held) => !input.roles.some((ref) => sameRef(held, ref)));
    }),

    dropUser: method(calls.dropUser, latencyMs, (input) => {
      context.guard(input.connectionId);
      const security = context.securityOf(input.connectionId);
      const user = findUser(security, input.db, input.user);
      security.users = security.users.filter((item) => item !== user);
    }),

    listRoles: method(calls.listRoles, latencyMs, ({ connectionId, database }) => {
      context.guard(connectionId);
      const custom = context.securityOf(connectionId).roles.filter((role) => role.db === database);
      return [...custom, ...builtinRoles(database)];
    }),

    createRole: method(calls.createRole, latencyMs, (input) => {
      context.guard(input.connectionId);
      refuseBuiltin(input.role, 'create');
      const security = context.securityOf(input.connectionId);
      if (findCustomRole(security, input.db, input.role) !== undefined) {
        throw fail('COMMAND_FAILED', 'Role already exists', `${input.role}@${input.db}`);
      }
      refuseSelfInheritance(input.role, input.db, input.roles);
      requireKnownRoles(security, input.roles);
      const created: RoleInfo = {
        id: userId(input.db, input.role),
        role: input.role,
        db: input.db,
        isBuiltin: false,
        roles: input.roles.map((ref) => roleRef(ref.role, ref.db)),
        privileges: input.privileges,
        authenticationRestrictions: input.authenticationRestrictions ?? [],
      };
      security.roles.push(created);
      return created;
    }),

    updateRole: method(calls.updateRole, latencyMs, (input) => {
      context.guard(input.connectionId);
      refuseBuiltin(input.role, 'update');
      const security = context.securityOf(input.connectionId);
      const role = findCustomRole(security, input.db, input.role);
      if (role === undefined) {
        throw fail('COMMAND_FAILED', 'Role not found', `${input.role}@${input.db}`);
      }
      if (input.roles !== undefined) {
        refuseSelfInheritance(input.role, input.db, input.roles);
        requireKnownRoles(security, input.roles);
        role.roles = input.roles.map((ref) => roleRef(ref.role, ref.db));
      }
      if (input.privileges !== undefined) {
        role.privileges = input.privileges;
      }
      if (input.authenticationRestrictions !== undefined) {
        role.authenticationRestrictions = input.authenticationRestrictions;
      }
    }),

    dropRole: method(calls.dropRole, latencyMs, (input) => {
      context.guard(input.connectionId);
      refuseBuiltin(input.role, 'drop');
      const security = context.securityOf(input.connectionId);
      const role = findCustomRole(security, input.db, input.role);
      if (role === undefined) {
        throw fail('COMMAND_FAILED', 'Role not found', `${input.role}@${input.db}`);
      }
      security.roles = security.roles.filter((item) => item !== role);
    }),

    capabilities: method(calls.capabilities, latencyMs, ({ connectionId }) => {
      context.guard(connectionId);
      return {
        canCreateUsers: !viewer,
        canGrantRoles: !viewer,
        canManageRoles: !viewer,
      };
    }),

    privilegeActions: method(calls.privilegeActions, latencyMs, () => privilegeActionCatalog()),
  };
}
