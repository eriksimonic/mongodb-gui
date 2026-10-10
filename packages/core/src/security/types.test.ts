import { describe, expect, it } from 'vitest';
import {
  ChangePasswordInputSchema,
  AuthStatusSchema,
  CreateRoleInputSchema,
  CreateUserInputSchema,
  DropRoleInputSchema,
  DropUserInputSchema,
  GrantRolesInputSchema,
  CreateRoleInputSchema as CreateRole,
  PasswordSchema,
  PrivilegeResourceSchema,
  PrivilegeInputSchema,
  PrivilegeResourceInputSchema,
  PrivilegeSchema,
  RoleRefInputSchema,
  GrantRolesInputSchema as GrantRoles,
  RoleInfoSchema,
  UpdateRoleInputSchema,
  UpdateUserRestrictionsInputSchema,
  UserInfoSchema,
  UserRefSchema,
} from './types';

const READ_WRITE_ROLE = { role: 'readWrite', db: 'shop' };
const ORDER_PRIVILEGE = {
  resource: { db: 'shop', collection: 'orders' },
  actions: ['find', 'update'],
};

describe('passwords', () => {
  it.each(['x', 'a'.repeat(256)])('accepts a password of length %s', (password) => {
    expect(PasswordSchema.safeParse(password).success).toBe(true);
  });

  it('rejects an empty password and one longer than 256 characters', () => {
    expect(PasswordSchema.safeParse('').success).toBe(false);
    expect(PasswordSchema.safeParse('a'.repeat(257)).success).toBe(false);
  });
});

describe('create user', () => {
  const valid = {
    db: 'shop',
    user: 'clerk',
    password: 'correct horse',
    roles: [READ_WRITE_ROLE],
    mechanisms: ['SCRAM-SHA-256'],
    authenticationRestrictions: [{ clientSource: ['127.0.0.1/32'] }],
  };

  it('accepts a complete input', () => {
    expect(CreateUserInputSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts empty roles', () => {
    expect(CreateUserInputSchema.safeParse({ ...valid, roles: [] }).success).toBe(true);
  });

  it('rejects a mechanism that is not SCRAM', () => {
    expect(CreateUserInputSchema.safeParse({ ...valid, mechanisms: ['PLAIN'] }).success).toBe(
      false,
    );
  });

  it('rejects a password that is too long without echoing it', () => {
    const result = CreateUserInputSchema.safeParse({ ...valid, password: 'p'.repeat(300) });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues ?? [])).not.toContain('ppppp');
  });
});

describe('user inputs', () => {
  it('requires a password for change password and a role list for grant', () => {
    expect(
      ChangePasswordInputSchema.safeParse({ db: 'shop', user: 'clerk', password: '' }).success,
    ).toBe(false);
    expect(GrantRolesInputSchema.safeParse({ db: 'shop', user: 'clerk', roles: [] }).success).toBe(
      false,
    );
  });

  it('accepts an empty restriction list to clear restrictions', () => {
    expect(
      UpdateUserRestrictionsInputSchema.safeParse({
        db: 'shop',
        user: 'clerk',
        authenticationRestrictions: [],
      }).success,
    ).toBe(true);
  });

  it('requires a database name that is valid', () => {
    expect(DropUserInputSchema.safeParse({ db: 'a.b', user: 'clerk' }).success).toBe(false);
  });
});

describe('privilege resources', () => {
  it.each([
    { cluster: true },
    { db: 'shop', collection: 'orders' },
    { db: '', collection: '' },
    { anyResource: true },
  ])('accepts %j', (resource) => {
    expect(PrivilegeResourceSchema.safeParse(resource).success).toBe(true);
  });

  it.each([{ cluster: false }, { db: 'shop' }, { anyResource: false }, {}])(
    'rejects %j',
    (resource) => {
      expect(PrivilegeResourceSchema.safeParse(resource).success).toBe(false);
    },
  );
});

describe('create and update role', () => {
  it('accepts a role with a privilege and a nested role', () => {
    expect(
      CreateRoleInputSchema.safeParse({
        db: 'shop',
        role: 'ordersEditor',
        privileges: [ORDER_PRIVILEGE],
        roles: [{ role: 'read', db: 'shop' }],
      }).success,
    ).toBe(true);
  });

  it('rejects an update that changes nothing', () => {
    expect(UpdateRoleInputSchema.safeParse({ db: 'shop', role: 'ordersEditor' }).success).toBe(
      false,
    );
  });

  it('accepts an update that clears privileges', () => {
    expect(
      UpdateRoleInputSchema.safeParse({ db: 'shop', role: 'ordersEditor', privileges: [] }).success,
    ).toBe(true);
  });

  it('requires a role name for drop', () => {
    expect(DropRoleInputSchema.safeParse({ db: 'shop', role: '' }).success).toBe(false);
  });
});

describe('external users', () => {
  it('accepts a user in $external without a password', () => {
    const input = { db: '$external', user: 'CN=test', roles: [READ_WRITE_ROLE] };
    expect(CreateUserInputSchema.safeParse(input).success).toBe(true);
    expect(UserRefSchema.safeParse({ db: '$external', user: 'CN=test' }).success).toBe(true);
  });

  it('rejects a password for a user in $external and a missing password elsewhere', () => {
    const withPassword = { db: '$external', user: 'CN=test', password: 'x', roles: [] };
    const withoutPassword = { db: 'shop', user: 'clerk', roles: [] };
    expect(CreateUserInputSchema.safeParse(withPassword).success).toBe(false);
    expect(CreateUserInputSchema.safeParse(withoutPassword).success).toBe(false);
  });

  it('refuses to change the password of a user in $external, by name', () => {
    const result = ChangePasswordInputSchema.safeParse({
      db: '$external',
      user: 'CN=test',
      password: 'x',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Users in $external have no password');
    expect(
      ChangePasswordInputSchema.safeParse({ db: 'shop', user: 'clerk', password: 'x' }).success,
    ).toBe(true);
  });

  it('keeps other databases free of $', () => {
    expect(UserRefSchema.safeParse({ db: 'bad$db', user: 'clerk' }).success).toBe(false);
  });
});

describe('system buckets resources', () => {
  it('accepts a time series buckets resource', () => {
    expect(
      PrivilegeResourceSchema.safeParse({ db: 'shop', system_buckets: 'metrics' }).success,
    ).toBe(true);
  });
});

describe('output schemas', () => {
  it('parses a user with inherited data and restrictions', () => {
    const user = {
      id: 'shop.clerk',
      user: 'clerk',
      db: 'shop',
      roles: [READ_WRITE_ROLE],
      mechanisms: ['SCRAM-SHA-256'],
      authenticationRestrictions: [{ clientSource: ['127.0.0.1/32'] }],
      customData: { team: 'sales' },
      inheritedRoles: [READ_WRITE_ROLE],
      inheritedPrivileges: [ORDER_PRIVILEGE],
    };
    expect(UserInfoSchema.parse(user)).toEqual(user);
  });

  it('parses a built-in role with no restrictions', () => {
    const role = {
      id: 'admin.root',
      role: 'root',
      db: 'admin',
      isBuiltin: true,
      roles: [],
      privileges: [{ resource: { anyResource: true }, actions: ['anyAction'] }],
      authenticationRestrictions: [],
    };
    expect(RoleInfoSchema.parse(role)).toEqual(role);
  });

  it('parses a connection status with no users', () => {
    expect(
      AuthStatusSchema.parse({
        authenticatedUsers: [],
        authenticatedUserRoles: [],
        authenticatedUserPrivileges: [],
      }),
    ).toEqual({
      authenticatedUsers: [],
      authenticatedUserRoles: [],
      authenticatedUserPrivileges: [],
    });
  });
});

describe('input names and actions', () => {
  const role = (fields: Record<string, unknown>) => ({
    db: 'shop',
    role: 'courier',
    privileges: [],
    roles: [],
    ...fields,
  });

  it('refuses an action the catalogue does not name, in a role input', () => {
    const result = CreateRole.safeParse(
      role({ privileges: [{ resource: { cluster: true }, actions: ['launchMissiles'] }] }),
    );
    expect(result.success).toBe(false);
    expect(
      PrivilegeInputSchema.safeParse({ resource: { cluster: true }, actions: ['launchMissiles'] })
        .success,
    ).toBe(false);
  });

  it('accepts catalogue actions, and keeps output privileges lenient for newer servers', () => {
    expect(
      PrivilegeInputSchema.safeParse({ resource: { cluster: true }, actions: ['serverStatus'] })
        .success,
    ).toBe(true);
    expect(
      PrivilegeSchema.safeParse({ resource: { cluster: true }, actions: ['launchMissiles'] })
        .success,
    ).toBe(true);
  });

  it.each([
    ['a $ database', { db: '$admin', collection: 'orders' }],
    ['a database with a dot', { db: 'shop.x', collection: 'orders' }],
    ['a database with a slash', { db: 'sh/op', collection: '' }],
    ['a database with a backslash', { db: 'sh\\op', collection: '' }],
    ['a database with a quote', { db: 'sh"op', collection: '' }],
    ['a database with a space', { db: 'sh op', collection: '' }],
    ['a database with a NUL', { db: 'sh\u0000op', collection: '' }],
    ['a collection starting with $', { db: 'shop', collection: '$cmd' }],
    ['a collection with a NUL', { db: 'shop', collection: 'a\u0000b' }],
  ])('refuses a privilege on %s', (_label, resource) => {
    expect(PrivilegeResourceInputSchema.safeParse(resource).success).toBe(false);
    expect(PrivilegeInputSchema.safeParse({ resource, actions: ['find'] }).success).toBe(false);
  });

  it('keeps dots in collection names and empty names for any collection or database', () => {
    expect(
      PrivilegeInputSchema.safeParse({
        resource: { db: 'shop', collection: 'orders.2026' },
        actions: ['find'],
      }).success,
    ).toBe(true);
    expect(
      PrivilegeInputSchema.safeParse({
        resource: { db: '', collection: 'orders' },
        actions: ['find'],
      }).success,
    ).toBe(true);
    expect(
      PrivilegeInputSchema.safeParse({ resource: { db: '', collection: '' }, actions: ['find'] })
        .success,
    ).toBe(true);
  });

  it.each([
    ['a role name starting with $', { role: '$custom', db: 'shop' }],
    ['a role database with a dot', { role: 'reader', db: 'shop.x' }],
  ])('refuses a role reference with %s', (_label, ref) => {
    expect(RoleRefInputSchema.safeParse(ref).success).toBe(false);
    expect(GrantRoles.safeParse({ db: 'shop', user: 'clerk', roles: [ref] }).success).toBe(false);
  });

  it('refuses a $ role name in a create role input and keeps user names permissive', () => {
    expect(CreateRole.safeParse(role({ role: '$system' })).success).toBe(false);
    expect(RoleRefInputSchema.safeParse({ role: 'reader', db: 'shop' }).success).toBe(true);
    expect(UserRefSchema.safeParse({ db: 'shop', user: 'ana.lopez@example.si' }).success).toBe(
      true,
    );
  });
});
