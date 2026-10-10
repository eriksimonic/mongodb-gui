import type { UserRoleRef } from '@mongo-gui/core';

/** A user as the connection authenticated it. */
export interface SignedInUser {
  readonly user: string;
  readonly db: string;
}

/** The roles that let a user manage other users. Revoking one from yourself can lock you out. */
const USER_ADMIN_ROLES: ReadonlySet<string> = new Set(['userAdmin', 'userAdminAnyDatabase']);

/** True when a revoke takes a user-admin role from the user the connection signed in as. */
export function isSelfRevokeOfUserAdmin(
  signedIn: readonly SignedInUser[],
  target: SignedInUser,
  revoked: readonly UserRoleRef[],
): boolean {
  const isSelf = signedIn.some((user) => user.user === target.user && user.db === target.db);
  return isSelf && revoked.some((ref) => USER_ADMIN_ROLES.has(ref.role));
}
