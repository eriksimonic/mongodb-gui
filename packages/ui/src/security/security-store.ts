import type {
  ChangePasswordInput,
  CreateRoleInput,
  CreateUserInput,
  DropRoleInput,
  DropUserInput,
  GrantRolesInput,
  PrivilegeActionCatalog,
  RevokeRolesInput,
  RoleInfo,
  RpcClient,
  UpdateRoleInput,
  UserInfo,
  UserManagementCapabilities,
} from '@mongo-gui/core';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { errorText } from '../components/notify-error';

/** The database the panel shows. Users and custom roles are read from it. */
export interface SecurityTarget {
  readonly connectionId: string;
  readonly database: string;
}

/** The part of the RPC client the panel uses. */
export type SecurityClient = RpcClient['security'];

/** Server-wide built-in roles are listed on admin only, so the role pickers read that list too. */
const BUILTIN_DATABASE = 'admin';

export interface SecurityState {
  /** Users of the target database. Undefined until the first load answers. */
  readonly users: readonly UserInfo[] | undefined;
  /** Roles of the target database, built-in roles included. */
  readonly roles: readonly RoleInfo[] | undefined;
  /** The users this connection signed in as. Read before a warning about a self-revoke. */
  readonly signedIn: readonly { readonly user: string; readonly db: string }[];
  /** Built-in roles and the target database's roles, for the role pickers. */
  readonly roleCatalog: readonly RoleInfo[];
  readonly capabilities: UserManagementCapabilities | undefined;
  readonly actions: PrivilegeActionCatalog | undefined;
  /** The text of the last failed load. Cleared by the next successful load. */
  readonly loadError: string | undefined;
  load(): Promise<void>;
  createUser(input: CreateUserInput): Promise<void>;
  changePassword(input: ChangePasswordInput): Promise<void>;
  grantRoles(input: GrantRolesInput): Promise<void>;
  revokeRoles(input: RevokeRolesInput): Promise<void>;
  dropUser(input: DropUserInput): Promise<void>;
  createRole(input: CreateRoleInput): Promise<void>;
  updateRole(input: UpdateRoleInput): Promise<void>;
  dropRole(input: DropRoleInput): Promise<void>;
}

export type SecurityStore = StoreApi<SecurityState>;

/**
 * The state of one users and roles panel. Each write goes to the server first. A write that the
 * server accepts reloads the lists. A write that fails throws the AppError text, so the dialog
 * that made the call shows it in its own alert.
 */
export function createSecurityStore(target: SecurityTarget, client: SecurityClient): SecurityStore {
  return createStore<SecurityState>()((set, get) => {
    // The privilege catalog is fixed for a server series, so it is read once per store.
    async function loadActions(): Promise<PrivilegeActionCatalog | undefined> {
      return get().actions ?? (await client.privilegeActions());
    }

    async function refresh(): Promise<void> {
      await get().load();
    }

    return {
      users: undefined,
      roles: undefined,
      roleCatalog: [],
      signedIn: [],
      capabilities: undefined,
      actions: undefined,
      loadError: undefined,

      async load() {
        const { connectionId, database } = target;
        try {
          const [users, roles, builtins, capabilities, actions, session] = await Promise.all([
            client.listUsers({ connectionId, database }),
            client.listRoles({ connectionId, database }),
            database === BUILTIN_DATABASE
              ? Promise.resolve<RoleInfo[]>([])
              : client.listRoles({ connectionId, database: BUILTIN_DATABASE }),
            client.capabilities({ connectionId, database }),
            loadActions(),
            client.session({ connectionId }),
          ]);
          const roleCatalog = [...builtins, ...roles];
          set({
            users,
            roles,
            roleCatalog,
            signedIn: session.authenticatedUsers,
            capabilities,
            actions,
            loadError: undefined,
          });
        } catch (failure) {
          set({ loadError: errorText(failure) });
        }
      },

      async createUser(input) {
        await client.createUser({ connectionId: target.connectionId, ...input });
        await refresh();
      },

      async changePassword(input) {
        await client.changePassword({ connectionId: target.connectionId, ...input });
      },

      async grantRoles(input) {
        await client.grantRoles({ connectionId: target.connectionId, ...input });
        await refresh();
      },

      async revokeRoles(input) {
        await client.revokeRoles({ connectionId: target.connectionId, ...input });
        await refresh();
      },

      async dropUser(input) {
        await client.dropUser({ connectionId: target.connectionId, ...input });
        await refresh();
      },

      async createRole(input) {
        await client.createRole({ connectionId: target.connectionId, ...input });
        await refresh();
      },

      async updateRole(input) {
        await client.updateRole({ connectionId: target.connectionId, ...input });
        await refresh();
      },

      async dropRole(input) {
        await client.dropRole({ connectionId: target.connectionId, ...input });
        await refresh();
      },
    };
  });
}
