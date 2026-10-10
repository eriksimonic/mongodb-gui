import { z } from 'zod';
import { DatabaseNameSchema } from '../management/types';
import { PRIVILEGE_ACTIONS } from './data';

const NonEmptySchema = z.string().min(1);

export const PasswordSchema = z.string().min(1).max(256);
export const ScramMechanismSchema = z.enum(['SCRAM-SHA-1', 'SCRAM-SHA-256']);

export const UserRoleRefSchema = z.object({
  role: NonEmptySchema,
  db: NonEmptySchema,
});

export const AuthRestrictionSchema = z.object({
  clientSource: z.array(NonEmptySchema).optional(),
  serverAddress: z.array(NonEmptySchema).optional(),
});

// An empty db or collection string means "all databases" or "all collections".
// system_buckets names the buckets of a time series collection. The server reports it as its
// own resource shape, so it is kept apart from a plain collection.
export const PrivilegeResourceSchema = z.union([
  z.object({ cluster: z.literal(true) }),
  z.object({ db: z.string(), collection: z.string() }),
  z.object({ db: z.string(), system_buckets: z.string() }),
  z.object({ anyResource: z.literal(true) }),
]);

export const PrivilegeSchema = z.object({
  resource: PrivilegeResourceSchema,
  actions: z.array(NonEmptySchema),
});

export const UserInfoSchema = z.object({
  id: NonEmptySchema,
  user: NonEmptySchema,
  db: NonEmptySchema,
  roles: z.array(UserRoleRefSchema),
  mechanisms: z.array(z.string()),
  authenticationRestrictions: z.array(AuthRestrictionSchema),
  customData: z.unknown().optional(),
  inheritedRoles: z.array(UserRoleRefSchema).optional(),
  inheritedPrivileges: z.array(PrivilegeSchema).optional(),
});

export const RoleInfoSchema = z.object({
  id: NonEmptySchema,
  role: NonEmptySchema,
  db: NonEmptySchema,
  isBuiltin: z.boolean(),
  roles: z.array(UserRoleRefSchema),
  privileges: z.array(PrivilegeSchema),
  inheritedRoles: z.array(UserRoleRefSchema).optional(),
  inheritedPrivileges: z.array(PrivilegeSchema).optional(),
  authenticationRestrictions: z.array(AuthRestrictionSchema),
});

export const AuthStatusSchema = z.object({
  authenticatedUsers: z.array(z.object({ user: NonEmptySchema, db: NonEmptySchema })),
  authenticatedUserRoles: z.array(UserRoleRefSchema),
  authenticatedUserPrivileges: z.array(PrivilegeSchema),
});

// What the signed-in user may do on one database. The UI shows a control only when its flag is
// true. The server still checks every command.
export const UserManagementCapabilitiesSchema = z.object({
  canCreateUsers: z.boolean(),
  canGrantRoles: z.boolean(),
  canManageRoles: z.boolean(),
});

// Input schemas. A password is never echoed back, so the schemas carry no value in issue text.

const DbSchema = DatabaseNameSchema;
// Users of the $external database (LDAP, Kerberos and x.509) live there. Every other user lives
// in a normal database.
export const UserDatabaseSchema = z.union([DatabaseNameSchema, z.literal('$external')]);
export const EXTERNAL_DATABASE = '$external';
const UserNameSchema = NonEmptySchema;
// Role names of a user-defined role. The $ prefix is reserved for the server's own names.
const RoleNameSchema = z
  .string()
  .min(1)
  .refine((name) => !name.startsWith('$'), { message: 'Role names may not start with $' });

// Input role references. The server's own output may name roles these rules would refuse, so the
// output schemas above stay lenient and only the inputs below are strict.
export const RoleRefInputSchema = z.object({
  role: RoleNameSchema,
  db: NonEmptySchema.refine((db) => !db.includes('.'), {
    message: 'Role databases may not contain .',
  }),
});
const RoleListSchema = z.array(RoleRefInputSchema);

// Every privilege action the core catalogue names. A newer server may know more actions, but the
// inputs accept only these, so a typo never reaches the server.
const CATALOGUE_ACTIONS: ReadonlySet<string> = new Set(
  Object.values(PRIVILEGE_ACTIONS).flatMap((names) => names),
);
export const CatalogueActionSchema = NonEmptySchema.refine(
  (action) => CATALOGUE_ACTIONS.has(action),
  {
    message: 'Unknown privilege action',
  },
);

// Collection names in a privilege may be empty (all collections) and may hold dots. Names
// starting with $ and names with a null byte are refused.
const PrivilegeCollectionSchema = z
  .string()
  .refine((name) => !name.startsWith('$'), { message: 'Collection names may not start with $' })
  .refine((name) => !name.includes('\u0000'), { message: 'Names may not contain a null byte' });
// The database of a privilege is empty for "any database", otherwise a valid database name.
const PrivilegeDatabaseSchema = z.union([z.literal(''), DatabaseNameSchema]);

export const PrivilegeResourceInputSchema = z.union([
  z.object({ cluster: z.literal(true) }),
  z.object({ db: PrivilegeDatabaseSchema, collection: PrivilegeCollectionSchema }),
  z.object({ db: PrivilegeDatabaseSchema, system_buckets: PrivilegeCollectionSchema }),
  z.object({ anyResource: z.literal(true) }),
]);

export const PrivilegeInputSchema = z.object({
  resource: PrivilegeResourceInputSchema,
  actions: z.array(CatalogueActionSchema),
});
const PrivilegeListSchema = z.array(PrivilegeInputSchema);
const RestrictionListSchema = z.array(AuthRestrictionSchema);

export const UserRefSchema = z.object({
  db: UserDatabaseSchema,
  user: UserNameSchema,
});

// A password is required for every user except one in $external, which authenticates outside
// MongoDB and so has none.
export const CreateUserInputSchema = z
  .object({
    db: UserDatabaseSchema,
    user: UserNameSchema,
    password: PasswordSchema.optional(),
    roles: RoleListSchema,
    mechanisms: z.array(ScramMechanismSchema).min(1).optional(),
    authenticationRestrictions: RestrictionListSchema.optional(),
    customData: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((input) => (input.db === EXTERNAL_DATABASE) === (input.password === undefined), {
    message: 'Give a password for a user in a database, and none for a user in $external',
    path: ['password'],
  });

// Users in $external have no MongoDB password to change, so the schema refuses them by name.
const PasswordUserDatabaseSchema = UserDatabaseSchema.refine((db) => db !== EXTERNAL_DATABASE, {
  message: 'Users in $external have no password',
});

export const ChangePasswordInputSchema = z.object({
  db: PasswordUserDatabaseSchema,
  user: UserNameSchema,
  password: PasswordSchema,
});

export const GrantRolesInputSchema = z.object({
  db: UserDatabaseSchema,
  user: UserNameSchema,
  roles: RoleListSchema.min(1),
});

export const RevokeRolesInputSchema = GrantRolesInputSchema;

export const DropUserInputSchema = UserRefSchema;

export const UpdateUserRestrictionsInputSchema = z.object({
  db: UserDatabaseSchema,
  user: UserNameSchema,
  authenticationRestrictions: RestrictionListSchema,
});

export const RoleRefSchema = z.object({
  db: DbSchema,
  role: RoleNameSchema,
});

export const CreateRoleInputSchema = z.object({
  db: DbSchema,
  role: RoleNameSchema,
  privileges: PrivilegeListSchema,
  roles: RoleListSchema,
  authenticationRestrictions: RestrictionListSchema.optional(),
});

export const UpdateRoleInputSchema = z
  .object({
    db: DbSchema,
    role: RoleNameSchema,
    privileges: PrivilegeListSchema.optional(),
    roles: RoleListSchema.optional(),
    authenticationRestrictions: RestrictionListSchema.optional(),
  })
  .refine(
    (input) =>
      input.privileges !== undefined ||
      input.roles !== undefined ||
      input.authenticationRestrictions !== undefined,
    { message: 'Give at least one of privileges, roles or authenticationRestrictions' },
  );

export const GrantPrivilegesInputSchema = z.object({
  db: DbSchema,
  role: RoleNameSchema,
  privileges: PrivilegeListSchema.min(1),
});

export const RevokePrivilegesInputSchema = GrantPrivilegesInputSchema;

export const GrantRolesToRoleInputSchema = z.object({
  db: DbSchema,
  role: RoleNameSchema,
  roles: RoleListSchema.min(1),
});

export const RevokeRolesFromRoleInputSchema = GrantRolesToRoleInputSchema;

export const DropRoleInputSchema = RoleRefSchema;

export type UserRoleRef = z.infer<typeof UserRoleRefSchema>;
export type AuthRestriction = z.infer<typeof AuthRestrictionSchema>;
export type PrivilegeResource = z.infer<typeof PrivilegeResourceSchema>;
export type Privilege = z.infer<typeof PrivilegeSchema>;
export type UserInfo = z.infer<typeof UserInfoSchema>;
export type RoleInfo = z.infer<typeof RoleInfoSchema>;
export type AuthStatus = z.infer<typeof AuthStatusSchema>;
export type UserManagementCapabilities = z.infer<typeof UserManagementCapabilitiesSchema>;
export type ScramMechanism = z.infer<typeof ScramMechanismSchema>;
export type UserRef = z.infer<typeof UserRefSchema>;
export type UserDatabase = z.infer<typeof UserDatabaseSchema>;
export type RoleRef = z.infer<typeof RoleRefSchema>;
export type CreateUserInput = z.infer<typeof CreateUserInputSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordInputSchema>;
export type GrantRolesInput = z.infer<typeof GrantRolesInputSchema>;
export type RevokeRolesInput = z.infer<typeof RevokeRolesInputSchema>;
export type DropUserInput = z.infer<typeof DropUserInputSchema>;
export type UpdateUserRestrictionsInput = z.infer<typeof UpdateUserRestrictionsInputSchema>;
export type CreateRoleInput = z.infer<typeof CreateRoleInputSchema>;
export type UpdateRoleInput = z.infer<typeof UpdateRoleInputSchema>;
export type GrantPrivilegesInput = z.infer<typeof GrantPrivilegesInputSchema>;
export type RevokePrivilegesInput = z.infer<typeof RevokePrivilegesInputSchema>;
export type GrantRolesToRoleInput = z.infer<typeof GrantRolesToRoleInputSchema>;
export type RevokeRolesFromRoleInput = z.infer<typeof RevokeRolesFromRoleInputSchema>;
export type DropRoleInput = z.infer<typeof DropRoleInputSchema>;
