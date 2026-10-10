import { z } from 'zod';
import { DatabaseNameSchema } from '../management/types';
import { PRIVILEGE_ACTIONS } from './data';
import {
  RoleInfoSchema,
  UserDatabaseSchema,
  UserInfoSchema,
  UserManagementCapabilitiesSchema,
} from './types';

// The RPC shapes of the users and roles panel. The connection id is added by the contract.

export const SecurityUserListInputSchema = z.object({ database: UserDatabaseSchema });
export const SecurityRoleListInputSchema = z.object({ database: DatabaseNameSchema });
export const SecurityCapabilitiesInputSchema = z.object({ database: UserDatabaseSchema });

export const SecurityUsersSchema = z.array(UserInfoSchema);
export const SecurityRolesSchema = z.array(RoleInfoSchema);

// Every category of privilege actions, each a list of action names. The keys match PRIVILEGE_ACTIONS.
export const PrivilegeActionCatalogSchema = z.object({
  queryAndWrite: z.array(z.string()),
  databaseManagement: z.array(z.string()),
  deploymentManagement: z.array(z.string()),
  changeStream: z.array(z.string()),
  replication: z.array(z.string()),
  sharding: z.array(z.string()),
  serverAdministration: z.array(z.string()),
  session: z.array(z.string()),
  searchIndex: z.array(z.string()),
  freeMonitoring: z.array(z.string()),
  diagnostic: z.array(z.string()),
  internal: z.array(z.string()),
} satisfies Record<keyof typeof PRIVILEGE_ACTIONS, z.ZodType>);

export type PrivilegeActionCatalog = z.infer<typeof PrivilegeActionCatalogSchema>;
export type SecurityCapabilities = z.infer<typeof UserManagementCapabilitiesSchema>;

/** The action names grouped by category, copied so a caller cannot change the core table. */
export function privilegeActionCatalog(): PrivilegeActionCatalog {
  return {
    queryAndWrite: [...PRIVILEGE_ACTIONS.queryAndWrite],
    databaseManagement: [...PRIVILEGE_ACTIONS.databaseManagement],
    deploymentManagement: [...PRIVILEGE_ACTIONS.deploymentManagement],
    changeStream: [...PRIVILEGE_ACTIONS.changeStream],
    replication: [...PRIVILEGE_ACTIONS.replication],
    sharding: [...PRIVILEGE_ACTIONS.sharding],
    serverAdministration: [...PRIVILEGE_ACTIONS.serverAdministration],
    session: [...PRIVILEGE_ACTIONS.session],
    searchIndex: [...PRIVILEGE_ACTIONS.searchIndex],
    freeMonitoring: [...PRIVILEGE_ACTIONS.freeMonitoring],
    diagnostic: [...PRIVILEGE_ACTIONS.diagnostic],
    internal: [...PRIVILEGE_ACTIONS.internal],
  };
}
