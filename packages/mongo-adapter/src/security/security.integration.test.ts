import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppErrorException,
  BUILTIN_ROLES,
  PRIVILEGE_ACTIONS,
  type AppError,
  type RoleInfo,
  type UserInfo,
} from '@mongo-gui/core';
import {
  CONTAINER_STARTUP_TIMEOUT_MS,
  MONGO_IMAGES,
  startMongo,
  type StartedMongo,
} from '../test/mongo-container';
import { canManageUsers, connectionStatus } from './current';
import {
  createRole,
  dropRole,
  getRole,
  grantPrivileges,
  grantRolesToRole,
  listRoles,
  revokePrivileges,
  revokeRolesFromRole,
  updateRole,
} from './roles';
import {
  changePassword,
  createUser,
  dropUser,
  getUser,
  grantRoles,
  listUsers,
  revokeRoles,
  updateUserRestrictions,
} from './users';

// Fixture documents use string _id values, which the driver's ObjectId default rejects.
type Doc = { _id: string; [field: string]: unknown };

const CLERK_PASSWORD = 'clerk-initial-pass';
const CLERK_ROTATED_PASSWORD = 'clerk-rotated-pass';
const EDITOR_PASSWORD = 'editor-pass-123';
const RESTRICTED_PASSWORD = 'restricted-pass-456';
const INTRUDER_PASSWORD = 'intruder-attempt-pass';
const AUTH_FAILED_CODE = 18;
const NOT_AUTHORIZED_CODE = 13;
const ORDERS_RESOURCE = { db: 'shop', collection: 'orders' };
const ORDER_ACTIONS = ['find', 'update'];
// The server keeps action lists sorted.
const UPDATED_ORDER_ACTIONS = ['find', 'remove', 'update'];

// A role in shop can target shop collections, but the server recognises an action only when it
// is valid for some resource. The probe tries the three kinds of resource in turn.
const PROBE_RESOURCES = [{ db: 'shop', collection: '' }, { cluster: true }, { anyResource: true }];
const UNRECOGNIZED_ACTION = 'Unrecognized action';

// Actions that the probe test found unknown on a given image. Each list is what the server
// reported when the test was written. Later servers recognise more actions, never fewer.
const UNKNOWN_ACTIONS_BY_IMAGE: Record<string, readonly string[]> = {
  'mongo:4.4': [
    'querySettings',
    'analyzeShardKey',
    'checkMetadataConsistency',
    'moveCollection',
    'reshardCollection',
    'rewriteCollection',
    'unshardCollection',
    'getClusterParameter',
    'shardedDataDistribution',
    'transitionFromDedicatedConfigServer',
    'transitionToDedicatedConfigServer',
    'bypassWriteBlockingMode',
    'bypassDefaultMaxTimeMS',
    'compactStructuredEncryptionData',
    'rotateCertificates',
    'setUserWriteBlockMode',
    'createSearchIndexes',
    'dropSearchIndex',
    'listSearchIndexes',
    'updateSearchIndex',
    'listClusterCatalog',
    'queryStatsRead',
    'queryStatsReadTransformed',
  ],
  'mongo:6.0': [
    'querySettings',
    'analyzeShardKey',
    'checkMetadataConsistency',
    'moveCollection',
    'rewriteCollection',
    'unshardCollection',
    'transitionFromDedicatedConfigServer',
    'transitionToDedicatedConfigServer',
    'bypassDefaultMaxTimeMS',
    'listClusterCatalog',
  ],
  'mongo:8.0.17': [],
};

// Builds a URI for another user on the same container, reusing the host and port of rootUri.
function uriFor(rootUri: string, user: string, password: string, authSource: string): string {
  const hostPart = rootUri.slice(rootUri.indexOf('@') + 1).split('?')[0];
  const credentials = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return `mongodb://${credentials}@${hostPart}/?authSource=${authSource}&directConnection=true`;
}

async function withClient<T>(uri: string, action: (client: MongoClient) => Promise<T>): Promise<T> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.close();
  }
}

async function captureError(action: () => Promise<unknown>): Promise<AppError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof AppErrorException) {
      return error.error;
    }
    throw error;
  }
  throw new Error('expected the action to fail with an AppErrorException');
}

// Returns undefined when the server accepts the action on the resource, else the server's reason.
async function probeGrant(
  client: MongoClient,
  action: string,
  resource: object,
): Promise<string | undefined> {
  try {
    await grantPrivileges(client, {
      db: 'shop',
      role: 'actionProbe',
      privileges: [{ resource, actions: [action] }],
    });
    return undefined;
  } catch (error) {
    const reason = error instanceof AppErrorException ? error.error : undefined;
    return reason?.detail ?? reason?.message ?? 'unknown failure';
  }
}

function findUser(users: UserInfo[], id: string): UserInfo | undefined {
  return users.find((user) => user.id === id);
}

function findRole(roles: RoleInfo[], id: string): RoleInfo | undefined {
  return roles.find((role) => role.id === id);
}

describe.each(MONGO_IMAGES)('users, roles and privileges on %s', (image) => {
  let mongo: StartedMongo;
  let root: MongoClient;

  beforeAll(async () => {
    mongo = await startMongo(image);
    root = new MongoClient(mongo.rootUri);
    await root.connect();
    await root
      .db('shop')
      .collection<Doc>('orders')
      .insertMany([
        { _id: 'o1', status: 'paid' },
        { _id: 'o2', status: 'open' },
      ]);
    await root.db('other').collection<Doc>('items').insertOne({ _id: 'i1', sku: 'x' });
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await root.close();
    await mongo.stop();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  it('lists the root user with the root role on admin', async () => {
    const users = await listUsers(root);
    const rootUser = findUser(users, 'admin.root');
    expect(rootUser?.roles).toEqual([{ role: 'root', db: 'admin' }]);

    const adminUsers = await listUsers(root, 'admin');
    expect(findUser(adminUsers, 'admin.root')).toBeDefined();
  });

  it('shows the built-in roles that the server reports for admin', async () => {
    const roles = await listRoles(root, 'admin');
    const names = new Set(roles.filter((role) => role.isBuiltin).map((role) => role.role));
    const missing = Object.values(BUILTIN_ROLES)
      .flatMap((group) => group)
      .filter((name) => !names.has(name));
    expect(missing).toEqual([]);
  });

  it('creates a user with readWrite on shop and SCRAM mechanisms', async () => {
    const created = await createUser(root, {
      db: 'shop',
      user: 'clerk',
      password: CLERK_PASSWORD,
      roles: [{ role: 'readWrite', db: 'shop' }],
      mechanisms: ['SCRAM-SHA-256'],
    });
    expect(created.id).toBe('shop.clerk');
    expect(created.roles).toEqual([{ role: 'readWrite', db: 'shop' }]);
    expect(created.mechanisms).toContain('SCRAM-SHA-256');
    expect(JSON.stringify(created)).not.toContain(CLERK_PASSWORD);
  });

  it('lets the new user write to shop and not to other', async () => {
    const uri = uriFor(mongo.rootUri, 'clerk', CLERK_PASSWORD, 'shop');
    await withClient(uri, async (client) => {
      await client.db('shop').collection<Doc>('orders').insertOne({ _id: 'o3', status: 'new' });
      const error = await client
        .db('other')
        .collection<Doc>('items')
        .insertOne({ _id: 'i2' })
        .catch((reason: unknown) => reason);
      expect(error).toMatchObject({ code: NOT_AUTHORIZED_CODE });
    });
  });

  it('invalidates the old password when it is changed and accepts the new one', async () => {
    await changePassword(root, { db: 'shop', user: 'clerk', password: CLERK_ROTATED_PASSWORD });
    await expect(
      withClient(uriFor(mongo.rootUri, 'clerk', CLERK_PASSWORD, 'shop'), async () => undefined),
    ).rejects.toMatchObject({ code: AUTH_FAILED_CODE });
    await withClient(
      uriFor(mongo.rootUri, 'clerk', CLERK_ROTATED_PASSWORD, 'shop'),
      async (client) => {
        await client.db('shop').collection<Doc>('orders').findOne({ _id: 'o1' });
      },
    );
  });

  it('grants read on other and revokes it again', async () => {
    const uri = uriFor(mongo.rootUri, 'clerk', CLERK_ROTATED_PASSWORD, 'shop');
    await grantRoles(root, { db: 'shop', user: 'clerk', roles: [{ role: 'read', db: 'other' }] });
    const granted = await withClient(uri, (client) =>
      client.db('other').collection<Doc>('items').findOne({ _id: 'i1' }),
    );
    expect(granted).toMatchObject({ _id: 'i1' });

    await revokeRoles(root, { db: 'shop', user: 'clerk', roles: [{ role: 'read', db: 'other' }] });
    await expect(
      withClient(uri, (client) =>
        client.db('other').collection<Doc>('items').findOne({ _id: 'i1' }),
      ),
    ).rejects.toMatchObject({ code: NOT_AUTHORIZED_CODE });
  });

  it('creates a custom role with find and update on shop.orders and a nested read role', async () => {
    const role = await createRole(root, {
      db: 'shop',
      role: 'orderEditor',
      privileges: [{ resource: ORDERS_RESOURCE, actions: ORDER_ACTIONS }],
      roles: [{ role: 'read', db: 'shop' }],
    });
    expect(role).toMatchObject({ id: 'shop.orderEditor', isBuiltin: false });
    expect(role.privileges).toEqual([{ resource: ORDERS_RESOURCE, actions: ORDER_ACTIONS }]);
    expect(role.roles).toEqual([{ role: 'read', db: 'shop' }]);
  });

  it('lets a user with the custom role update orders but not remove them', async () => {
    await createUser(root, {
      db: 'shop',
      user: 'editor',
      password: EDITOR_PASSWORD,
      roles: [{ role: 'orderEditor', db: 'shop' }],
    });
    await withClient(uriFor(mongo.rootUri, 'editor', EDITOR_PASSWORD, 'shop'), async (client) => {
      const orders = client.db('shop').collection<Doc>('orders');
      await orders.updateOne({ _id: 'o2' }, { $set: { status: 'paid' } });
      await expect(orders.deleteOne({ _id: 'o2' })).rejects.toMatchObject({
        code: NOT_AUTHORIZED_CODE,
      });
    });
  });

  it('reports inherited privileges from the nested role in rolesInfo', async () => {
    const role = await getRole(root, 'shop', 'orderEditor');
    const inherited = role?.inheritedPrivileges ?? [];
    expect(inherited).toContainEqual(
      expect.objectContaining({
        resource: { db: 'shop', collection: '' },
        actions: expect.arrayContaining(['find']),
      }),
    );
    expect(role?.inheritedRoles).toEqual([{ role: 'read', db: 'shop' }]);

    const editor = await getUser(root, 'shop', 'editor');
    expect(editor?.inheritedRoles).toContainEqual({ role: 'orderEditor', db: 'shop' });
    expect(editor?.inheritedPrivileges).toContainEqual(
      expect.objectContaining({
        resource: ORDERS_RESOURCE,
        actions: expect.arrayContaining(['find']),
      }),
    );
  });

  it('updates the role privileges so the user can remove orders', async () => {
    await updateRole(root, {
      db: 'shop',
      role: 'orderEditor',
      privileges: [{ resource: ORDERS_RESOURCE, actions: UPDATED_ORDER_ACTIONS }],
    });
    const role = await getRole(root, 'shop', 'orderEditor');
    expect(role?.privileges).toEqual([
      { resource: ORDERS_RESOURCE, actions: UPDATED_ORDER_ACTIONS },
    ]);
    await withClient(uriFor(mongo.rootUri, 'editor', EDITOR_PASSWORD, 'shop'), (client) =>
      client.db('shop').collection<Doc>('orders').deleteOne({ _id: 'o2' }),
    );
  });

  it('grants and revokes privileges and nested roles on a custom role', async () => {
    const customers = { db: 'shop', collection: 'customers' };
    await grantPrivileges(root, {
      db: 'shop',
      role: 'orderEditor',
      privileges: [{ resource: customers, actions: ['find'] }],
    });
    expect((await getRole(root, 'shop', 'orderEditor'))?.privileges).toContainEqual({
      resource: customers,
      actions: ['find'],
    });
    await revokePrivileges(root, {
      db: 'shop',
      role: 'orderEditor',
      privileges: [{ resource: customers, actions: ['find'] }],
    });
    expect((await getRole(root, 'shop', 'orderEditor'))?.privileges).toEqual([
      { resource: ORDERS_RESOURCE, actions: UPDATED_ORDER_ACTIONS },
    ]);

    await createRole(root, { db: 'shop', role: 'statsReader', privileges: [], roles: [] });
    const statsReader = { role: 'statsReader', db: 'shop' };
    await grantRolesToRole(root, { db: 'shop', role: 'orderEditor', roles: [statsReader] });
    expect((await getRole(root, 'shop', 'orderEditor'))?.roles).toContainEqual(statsReader);
    await revokeRolesFromRole(root, { db: 'shop', role: 'orderEditor', roles: [statsReader] });
    expect((await getRole(root, 'shop', 'orderEditor'))?.roles).toEqual([
      { role: 'read', db: 'shop' },
    ]);
    await dropRole(root, { db: 'shop', role: 'statsReader' });
  });

  it('removes the role from a user when the role is dropped', async () => {
    await createRole(root, {
      db: 'shop',
      role: 'tempRole',
      privileges: [{ resource: { db: 'shop', collection: '' }, actions: ['find'] }],
      roles: [],
    });
    await grantRoles(root, {
      db: 'shop',
      user: 'editor',
      roles: [{ role: 'tempRole', db: 'shop' }],
    });
    await dropRole(root, { db: 'shop', role: 'tempRole' });
    expect(await getRole(root, 'shop', 'tempRole')).toBeNull();
    const editor = await getUser(root, 'shop', 'editor');
    expect(editor?.roles).toEqual([{ role: 'orderEditor', db: 'shop' }]);
  });

  it('refuses to create, update, grant to or drop a built-in role without reaching the server', async () => {
    const reasons = await Promise.all([
      captureError(() =>
        createRole(root, { db: 'shop', role: 'readWrite', privileges: [], roles: [] }),
      ),
      captureError(() => updateRole(root, { db: 'shop', role: 'read', roles: [] })),
      captureError(() =>
        grantPrivileges(root, {
          db: 'shop',
          role: 'root',
          privileges: [{ resource: { anyResource: true }, actions: ['find'] }],
        }),
      ),
      captureError(() => dropRole(root, { db: 'shop', role: 'dbOwner' })),
    ]);
    for (const reason of reasons) {
      expect(reason.code).toBe('VALIDATION');
    }
  });

  it('reports the authenticated users of root and of the limited user', async () => {
    const rootStatus = await connectionStatus(root);
    expect(rootStatus.authenticatedUsers).toContainEqual({ user: 'root', db: 'admin' });
    expect(rootStatus.authenticatedUserRoles).toContainEqual({ role: 'root', db: 'admin' });
    expect(rootStatus.authenticatedUserPrivileges.length).toBeGreaterThan(0);

    await withClient(
      uriFor(mongo.rootUri, 'clerk', CLERK_ROTATED_PASSWORD, 'shop'),
      async (client) => {
        const status = await connectionStatus(client);
        expect(status.authenticatedUsers).toEqual([{ user: 'clerk', db: 'shop' }]);
        expect(status.authenticatedUserRoles).toEqual([{ role: 'readWrite', db: 'shop' }]);
      },
    );
  });

  it('reports user management rights for root and not for the limited user', async () => {
    expect(await canManageUsers(root, 'shop')).toBe(true);
    await withClient(
      uriFor(mongo.rootUri, 'clerk', CLERK_ROTATED_PASSWORD, 'shop'),
      async (client) => {
        expect(await canManageUsers(client, 'shop')).toBe(false);
      },
    );
  });

  it('refuses user creation from the limited user with a detail that has no password', async () => {
    await withClient(
      uriFor(mongo.rootUri, 'clerk', CLERK_ROTATED_PASSWORD, 'shop'),
      async (client) => {
        const error = await captureError(() =>
          createUser(client, {
            db: 'shop',
            user: 'intruder',
            password: INTRUDER_PASSWORD,
            roles: [{ role: 'root', db: 'admin' }],
          }),
        );
        expect(error.code).toBe('COMMAND_FAILED');
        expect(error.detail).toBeDefined();
        expect(JSON.stringify(error)).not.toContain(INTRUDER_PASSWORD);
      },
    );
  });

  it('stores and returns an authentication restriction, and clears it on request', async () => {
    const created = await createUser(root, {
      db: 'shop',
      user: 'restricted',
      password: RESTRICTED_PASSWORD,
      roles: [{ role: 'read', db: 'shop' }],
      authenticationRestrictions: [{ clientSource: ['127.0.0.1/32'] }],
    });
    expect(created.authenticationRestrictions).toEqual([{ clientSource: ['127.0.0.1/32'] }]);

    const fetched = await getUser(root, 'shop', 'restricted');
    expect(fetched?.authenticationRestrictions).toEqual([{ clientSource: ['127.0.0.1/32'] }]);

    await updateUserRestrictions(root, {
      db: 'shop',
      user: 'restricted',
      authenticationRestrictions: [],
    });
    expect((await getUser(root, 'shop', 'restricted'))?.authenticationRestrictions).toEqual([]);
    await dropUser(root, { db: 'shop', user: 'restricted' });
  });

  it('drops the limited user, after which it cannot connect', async () => {
    await dropUser(root, { db: 'shop', user: 'clerk' });
    expect(await getUser(root, 'shop', 'clerk')).toBeNull();
    await expect(
      withClient(
        uriFor(mongo.rootUri, 'clerk', CLERK_ROTATED_PASSWORD, 'shop'),
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: AUTH_FAILED_CODE });
  });

  it('lists custom roles and built-in roles per database', async () => {
    const roles = await listRoles(root, 'shop');
    expect(findRole(roles, 'shop.readWrite')?.isBuiltin).toBe(true);
    expect(findRole(roles, 'shop.orderEditor')?.isBuiltin).toBe(false);
  });

  it('recognises every privilege action in PRIVILEGE_ACTIONS, with the known exceptions', async () => {
    await createRole(root, { db: 'shop', role: 'actionProbe', privileges: [], roles: [] });
    const unknown: string[] = [];
    for (const action of Object.values(PRIVILEGE_ACTIONS).flatMap((group) => group)) {
      const outcomes: (string | undefined)[] = [];
      for (const resource of PROBE_RESOURCES) {
        outcomes.push(await probeGrant(root, action, resource));
      }
      const accepted = outcomes.includes(undefined);
      if (!accepted && outcomes.every((reason) => reason?.includes(UNRECOGNIZED_ACTION))) {
        unknown.push(action);
      }
    }
    await dropRole(root, { db: 'shop', role: 'actionProbe' });
    expect(unknown).toEqual(UNKNOWN_ACTIONS_BY_IMAGE[image]);
  });
});
