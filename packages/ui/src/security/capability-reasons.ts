import type { UserManagementCapabilities } from '@mongo-gui/core';

export const CREATE_USERS_REASON =
  'The signed-in user cannot create or drop users on this database.';
export const GRANT_ROLES_REASON =
  'The signed-in user cannot grant or revoke roles on this database.';
export const MANAGE_ROLES_REASON =
  'The signed-in user cannot create, change or drop roles on this database.';
const LOADING_REASON = "Checking the signed-in user's rights.";

/** The reason a control is off: the rights still loading, or the denied reason once they are read. */
export function capabilityReason(
  capabilities: UserManagementCapabilities | undefined,
  denied: string,
): string {
  return capabilities === undefined ? LOADING_REASON : denied;
}
