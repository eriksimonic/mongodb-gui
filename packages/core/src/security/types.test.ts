import { describe, expect, it } from 'vitest';
import {
  ChangePasswordInputSchema,
  AuthStatusSchema,
  CreateRoleInputSchema,
  CreateUserInputSchema,
  DropRoleInputSchema,
  DropUserInputSchema,
  GrantRolesInputSchema,
  PasswordSchema,
  PrivilegeResourceSchema,
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
