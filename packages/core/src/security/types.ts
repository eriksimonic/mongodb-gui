import { z } from 'zod';
import { DatabaseNameSchema } from '../management/types';

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
export const PrivilegeResourceSchema = z.union([
  z.object({ cluster: z.literal(true) }),
  z.object({ db: z.string(), collection: z.string() }),
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

// Input schemas. A password is never echoed back, so the schemas carry no value in issue text.

const DbSchema = DatabaseNameSchema;
const UserNameSchema = NonEmptySchema;
const RoleNameSchema = NonEmptySchema;
const RoleListSchema = z.array(UserRoleRefSchema);
const RestrictionListSchema = z.array(AuthRestrictionSchema);
const PrivilegeListSchema = z.array(PrivilegeSchema);

export const UserRefSchema = z.object({
  db: DbSchema,
  user: UserNameSchema,
});

export const CreateUserInputSchema = z.object({
  db: DbSchema,
  user: UserNameSchema,
  password: PasswordSchema,
  roles: RoleListSchema,
  mechanisms: z.array(ScramMechanismSchema).min(1).optional(),
  authenticationRestrictions: RestrictionListSchema.optional(),
  customData: z.record(z.string(), z.unknown()).optional(),
});

export const ChangePasswordInputSchema = z.object({
  db: DbSchema,
  user: UserNameSchema,
  password: PasswordSchema,
});

export const GrantRolesInputSchema = z.object({
  db: DbSchema,
  user: UserNameSchema,
  roles: RoleListSchema.min(1),
});

export const RevokeRolesInputSchema = GrantRolesInputSchema;

export const DropUserInputSchema = UserRefSchema;

export const UpdateUserRestrictionsInputSchema = z.object({
  db: DbSchema,
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
export type ScramMechanism = z.infer<typeof ScramMechanismSchema>;
export type UserRef = z.infer<typeof UserRefSchema>;
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
