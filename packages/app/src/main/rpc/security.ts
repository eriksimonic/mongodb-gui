import {
  AppErrorException,
  privilegeActionCatalog,
  rpcContract,
  type AppError,
  type CallInput,
  type RpcCall,
  type UserInfo,
} from '@mongo-gui/core';
import {
  changePassword,
  connectionStatus,
  createRole,
  createUser,
  dropRole,
  dropUser,
  grantRoles,
  listRoles,
  listUsers,
  redactPassword,
  revokeRoles,
  toCanonicalEjson,
  updateRole,
  userManagementCapabilities,
} from '@mongo-gui/mongo-adapter';
import { driverCall, entry, type Operation } from './operation';

/** The client a users and roles call runs against. */
type SecurityClient = Parameters<typeof listUsers>[0];

export interface SecurityDeps {
  getClient: (connectionId: string) => SecurityClient;
}

/** Every connection-scoped input names the connection it runs against. */
interface ConnectionScoped {
  readonly connectionId: string;
}

export function securityOperations(deps: SecurityDeps): [string, Operation][] {
  /**
   * A users and roles call. Passwords come in through the input and are masked in any error text
   * before the response leaves. Nothing else from the input reaches the response or the log.
   */
  function secured<C extends RpcCall>(
    method: string,
    call: C,
    run: (client: SecurityClient, input: CallInput<C>) => Promise<unknown>,
    secretsOf: (input: CallInput<C>) => readonly string[] = () => [],
  ): [string, Operation] {
    return entry(method, call, (input) => {
      const { connectionId } = input as ConnectionScoped;
      return maskedCall(secretsOf(input), () =>
        driverCall(() => run(deps.getClient(connectionId), input)),
      );
    });
  }

  const s = rpcContract.security;
  return [
    secured('security.listUsers', s.listUsers, async (client, input) =>
      (await listUsers(client, input.database)).map(withEjsonCustomData),
    ),
    secured(
      'security.createUser',
      s.createUser,
      async (client, input) => withEjsonCustomData(await createUser(client, input)),
      (input) => (input.password === undefined ? [] : [input.password]),
    ),
    secured(
      'security.changePassword',
      s.changePassword,
      (client, input) => changePassword(client, input),
      (input) => [input.password],
    ),
    secured('security.grantRoles', s.grantRoles, (client, input) => grantRoles(client, input)),
    secured('security.revokeRoles', s.revokeRoles, (client, input) => revokeRoles(client, input)),
    secured('security.dropUser', s.dropUser, (client, input) => dropUser(client, input)),
    secured('security.listRoles', s.listRoles, (client, input) =>
      listRoles(client, input.database),
    ),
    secured('security.createRole', s.createRole, (client, input) => createRole(client, input)),
    secured('security.updateRole', s.updateRole, (client, input) => updateRole(client, input)),
    secured('security.dropRole', s.dropRole, (client, input) => dropRole(client, input)),
    secured('security.session', s.session, (client) => connectionStatus(client)),
    secured('security.capabilities', s.capabilities, (client, input) =>
      userManagementCapabilities(client, input.database),
    ),
    entry('security.privilegeActions', s.privilegeActions, () => privilegeActionCatalog()),
  ];
}

/** Runs a call whose error text may carry secrets. AppErrors are masked, others pass through. */
async function maskedCall<T>(secrets: readonly string[], action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AppErrorException) {
      throw new AppErrorException(maskError(error.error, secrets));
    }
    throw error;
  }
}

function maskError(error: AppError, secrets: readonly string[]): AppError {
  const mask = (text: string): string =>
    secrets.reduce((value, secret) => redactPassword(value, secret), redactPassword(text));
  const { detail, cause, ...rest } = error;
  return {
    ...rest,
    message: mask(rest.message),
    ...(detail === undefined ? {} : { detail: mask(detail) }),
    ...(cause === undefined ? {} : { cause: mask(cause) }),
  };
}

/** Custom data leaves the main process as canonical EJSON, so BSON types survive the IPC hop. */
function withEjsonCustomData(user: UserInfo): UserInfo {
  if (user.customData === undefined) {
    return user;
  }
  const { customData, ...rest } = user;
  const canonical = toCanonicalEjson(customData);
  return canonical === undefined ? rest : { ...rest, customData: canonical };
}
