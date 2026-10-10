import type { PrivilegeActionCatalog, RoleInfo } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import {
  actionGroups,
  draftFromPrivilege,
  newPrivilegeDraft,
  privilegeFromDraft,
  privilegesFromDrafts,
  privilegeSummary,
  resourceLabel,
  roleGroups,
  roleRefFromValue,
  roleValue,
  toggleAction,
  type PrivilegeDraft,
} from './privilege-model';

const CATALOG: PrivilegeActionCatalog = {
  queryAndWrite: ['find', 'insert', 'update'],
  databaseManagement: ['createIndex', 'dropCollection'],
  deploymentManagement: [],
  changeStream: [],
  replication: [],
  sharding: [],
  serverAdministration: [],
  session: [],
  searchIndex: [],
  freeMonitoring: [],
  diagnostic: ['listIndexes'],
  internal: [],
};

const draft = (fields: Partial<PrivilegeDraft>): PrivilegeDraft => ({
  key: 'k',
  kind: 'database',
  db: 'shop',
  collection: '',
  actions: ['find'],
  ...fields,
});

describe('draftFromPrivilege', () => {
  it('reads each resource shape into its row kind', () => {
    expect(
      draftFromPrivilege({ resource: { cluster: true }, actions: ['serverStatus'] }, 'a'),
    ).toMatchObject({
      kind: 'cluster',
    });
    expect(
      draftFromPrivilege({ resource: { anyResource: true }, actions: ['find'] }, 'a'),
    ).toMatchObject({
      kind: 'anyResource',
    });
    expect(
      draftFromPrivilege({ resource: { db: '', collection: '' }, actions: ['find'] }, 'a'),
    ).toMatchObject({
      kind: 'anyDatabase',
    });
    expect(
      draftFromPrivilege({ resource: { db: 'shop', collection: '' }, actions: ['find'] }, 'a'),
    ).toMatchObject({
      kind: 'database',
      db: 'shop',
    });
    expect(
      draftFromPrivilege(
        { resource: { db: 'shop', collection: 'orders' }, actions: ['find'] },
        'a',
      ),
    ).toMatchObject({ kind: 'collection', db: 'shop', collection: 'orders' });
  });

  it('keeps a time series bucket resource so saving writes it back unchanged', () => {
    const privilege = {
      resource: { db: 'shop', system_buckets: 'events' },
      actions: ['find'],
    };
    const row = draftFromPrivilege(privilege, 'a');
    expect(row.kind).toBe('systemBuckets');
    expect(privilegeFromDraft(row, 'other')).toEqual({ privilege });
  });

  it('copies the actions so editing a row does not change the privilege it came from', () => {
    const privilege = { resource: { cluster: true as const }, actions: ['serverStatus'] };
    const row = draftFromPrivilege(privilege, 'a');
    expect(row.actions).not.toBe(privilege.actions);
  });
});

describe('privilegeFromDraft', () => {
  it('builds the resource each row kind names', () => {
    expect(
      privilegeFromDraft(draft({ kind: 'cluster', actions: ['serverStatus'] }), 'shop'),
    ).toEqual({
      privilege: { resource: { cluster: true }, actions: ['serverStatus'] },
    });
    expect(privilegeFromDraft(draft({ kind: 'anyResource' }), 'shop')).toEqual({
      privilege: { resource: { anyResource: true }, actions: ['find'] },
    });
    expect(privilegeFromDraft(draft({ kind: 'anyDatabase' }), 'shop')).toEqual({
      privilege: { resource: { db: '', collection: '' }, actions: ['find'] },
    });
    expect(privilegeFromDraft(draft({ kind: 'database', db: '' }), 'shop')).toEqual({
      privilege: { resource: { db: 'shop', collection: '' }, actions: ['find'] },
    });
  });

  it('names the collection and the database it lives in', () => {
    expect(
      privilegeFromDraft(draft({ kind: 'collection', db: 'shop', collection: 'orders' }), 'admin'),
    ).toEqual({ privilege: { resource: { db: 'shop', collection: 'orders' }, actions: ['find'] } });
    expect(
      privilegeFromDraft(draft({ kind: 'collection', db: '', collection: 'orders' }), 'admin'),
    ).toEqual({
      privilege: { resource: { db: 'admin', collection: 'orders' }, actions: ['find'] },
    });
  });

  it('refuses a row without actions, and a collection row without a valid name', () => {
    expect(privilegeFromDraft(draft({ actions: [] }), 'shop')).toEqual({
      error: 'Choose at least one action for each row.',
    });
    expect(privilegeFromDraft(draft({ kind: 'collection', collection: '' }), 'shop')).toEqual({
      error: 'Enter a collection name',
    });
    expect(
      privilegeFromDraft(draft({ kind: 'collection', collection: 'a$b' }), 'shop'),
    ).toHaveProperty('error');
    expect(
      privilegeFromDraft(
        draft({ kind: 'collection', db: 'bad name', collection: 'orders' }),
        'shop',
      ),
    ).toHaveProperty('error');
  });
});

describe('privilegesFromDrafts', () => {
  it('keeps the row order and stops at the first bad row', () => {
    const good = newPrivilegeDraft('1', 'shop');
    const built = privilegesFromDrafts(
      [draft({ key: 'a', kind: 'cluster' }), { ...good, actions: ['find'] }],
      'shop',
    );
    expect(built).toEqual({
      privileges: [
        { resource: { cluster: true }, actions: ['find'] },
        { resource: { db: 'shop', collection: '' }, actions: ['find'] },
      ],
    });
    expect(privilegesFromDrafts([draft({ actions: [] })], 'shop')).toEqual({
      error: 'Choose at least one action for each row.',
    });
  });

  it('accepts no rows, which is a role with no privileges of its own', () => {
    expect(privilegesFromDrafts([], 'shop')).toEqual({ privileges: [] });
  });
});

describe('resource text', () => {
  it('reads each resource as the editor names it', () => {
    expect(resourceLabel({ cluster: true })).toBe('Cluster');
    expect(resourceLabel({ anyResource: true })).toBe('Any resource');
    expect(resourceLabel({ db: '', collection: '' })).toBe('Any database');
    expect(resourceLabel({ db: 'shop', collection: '' })).toBe('Database shop');
    expect(resourceLabel({ db: 'shop', collection: 'orders' })).toBe('shop.orders');
    expect(resourceLabel({ db: 'shop', system_buckets: 'events' })).toBe(
      'Time series buckets of shop.events',
    );
  });

  it('summarises a privilege as its actions and its resource', () => {
    expect(
      privilegeSummary({
        resource: { db: 'shop', collection: 'orders' },
        actions: ['find', 'insert'],
      }),
    ).toBe('find, insert on shop.orders');
  });
});

describe('actionGroups', () => {
  it('lists the categories in order and drops the empty ones', () => {
    const groups = actionGroups(CATALOG);
    expect(groups.map((group) => group.label)).toEqual([
      'Query and write',
      'Database management',
      'Diagnostics',
    ]);
    expect(groups[0]?.items.map((item) => item.value)).toEqual(['find', 'insert', 'update']);
  });

  it('keeps the actions whose name contains the query, ignoring case', () => {
    const groups = actionGroups(CATALOG, 'INDEX');
    expect(groups.flatMap((group) => group.items.map((item) => item.value))).toEqual([
      'createIndex',
      'listIndexes',
    ]);
    expect(actionGroups(CATALOG, 'nothing like this')).toEqual([]);
  });
});

describe('toggleAction', () => {
  it('adds an absent action and removes a present one, without touching the input', () => {
    const actions = ['find'];
    expect(toggleAction(actions, 'insert')).toEqual(['find', 'insert']);
    expect(toggleAction(actions, 'find')).toEqual([]);
    expect(actions).toEqual(['find']);
  });
});

describe('role references', () => {
  it('round-trips a reference through its picker value', () => {
    const value = roleValue({ role: 'readWrite', db: 'shop' });
    expect(value).toBe('shop/readWrite');
    expect(roleRefFromValue(value)).toEqual({ role: 'readWrite', db: 'shop' });
  });

  it('groups built-in and custom roles by database, once each', () => {
    const roles: RoleInfo[] = [
      role('shop', 'analyst', false),
      role('admin', 'read', true),
      role('admin', 'read', true),
      role('admin', 'root', true),
    ];
    expect(roleGroups(roles)).toEqual([
      {
        group: 'admin',
        items: [
          { value: 'admin/read', label: 'read (built-in)' },
          { value: 'admin/root', label: 'root (built-in)' },
        ],
      },
      { group: 'shop', items: [{ value: 'shop/analyst', label: 'analyst' }] },
    ]);
  });
});

function role(db: string, name: string, isBuiltin: boolean): RoleInfo {
  return {
    id: `${db}.${name}`,
    role: name,
    db,
    isBuiltin,
    roles: [],
    privileges: [],
    authenticationRestrictions: [],
  };
}
