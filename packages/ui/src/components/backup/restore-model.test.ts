import type { BackupInspection } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import {
  databaseCheckState,
  draftFromInspection,
  includeFrom,
  isCollectionChecked,
  renameRows,
  restoreProblemsOf,
  restoreStartInput,
  setRename,
  toggleCollection,
  toggleDatabase,
} from './restore-model';

const ID = '3f2b8c1e-6a4d-4f0e-9d57-0a1b2c3d4e5f';

function ns(database: string, collection: string) {
  return { database, collection, type: 'collection' as const };
}

const INSPECTION: Pick<
  BackupInspection,
  'namespaces' | 'hasOplog' | 'hasUsersAndRoles' | 'sidecar' | 'prelude'
> = {
  namespaces: [ns('shop', 'orders'), ns('shop', 'users'), ns('blog', 'posts')],
  hasOplog: false,
  hasUsersAndRoles: false,
  prelude: { toolsVersion: '100.9.4' },
};

const OPTIONS = { installedVersions: ['100.9.4', '100.10.0'], preference: '100.10.0' };

describe('restore model', () => {
  it('starts with everything checked and the dump tools version when installed', () => {
    const draft = draftFromInspection(INSPECTION, OPTIONS);
    expect(draft.unchecked).toEqual([]);
    expect(draft.toolsVersion).toBe('100.9.4');
    expect(includeFrom(draft)).toBeUndefined();
    expect(draft.verifyChecksum).toBe(true);
  });

  it('falls back to the preference when the dump tools are not installed', () => {
    const draft = draftFromInspection(INSPECTION, { ...OPTIONS, installedVersions: ['100.10.0'] });
    expect(draft.toolsVersion).toBe('100.10.0');
    const none = draftFromInspection(INSPECTION, { installedVersions: [] });
    expect(none.toolsVersion).toBe('');
  });

  it('prefills the rename target when the dump holds one database', () => {
    const single = { ...INSPECTION, namespaces: [ns('shop', 'orders'), ns('shop', 'users')] };
    const draft = draftFromInspection(single, { ...OPTIONS, targetDatabase: 'shop_copy' });
    expect(renameRows(draft)).toEqual([{ from: 'shop', to: 'shop_copy', exists: false }]);

    const several = draftFromInspection(INSPECTION, { ...OPTIONS, targetDatabase: 'shop_copy' });
    expect(several.renameTo).toEqual({});
  });

  it('tracks the check state of databases and collections', () => {
    let draft = draftFromInspection(INSPECTION, OPTIONS);
    draft = toggleCollection(draft, 'shop', 'users', false);
    expect(databaseCheckState(draft, 'shop')).toBe('some');
    expect(databaseCheckState(draft, 'blog')).toBe('all');
    expect(isCollectionChecked(draft, 'shop', 'users')).toBe(false);

    draft = toggleDatabase(draft, 'shop', false);
    expect(databaseCheckState(draft, 'shop')).toBe('none');
    draft = toggleDatabase(draft, 'shop', true);
    expect(databaseCheckState(draft, 'shop')).toBe('all');
    expect(draft.unchecked).toEqual([]);
  });

  it('does not duplicate an unchecked collection', () => {
    let draft = draftFromInspection(INSPECTION, OPTIONS);
    draft = toggleCollection(draft, 'shop', 'users', false);
    draft = toggleCollection(draft, 'shop', 'users', false);
    expect(draft.unchecked).toEqual(['shop.users']);
  });

  it('turns the checks into include selectors', () => {
    let draft = draftFromInspection(INSPECTION, OPTIONS);
    draft = toggleCollection(draft, 'shop', 'users', false);
    expect(includeFrom(draft)).toEqual(['shop.orders', 'blog.*']);

    draft = toggleDatabase(draft, 'shop', false);
    expect(includeFrom(draft)).toEqual(['blog.*']);

    draft = toggleDatabase(draft, 'blog', false);
    expect(includeFrom(draft)).toEqual([]);
  });

  it('lists a rename row for each database with something checked', () => {
    let draft = draftFromInspection(INSPECTION, OPTIONS);
    draft = setRename(draft, 'shop', 'shop_copy');
    expect(renameRows(draft, ['shop_copy', 'blog'])).toEqual([
      { from: 'shop', to: 'shop_copy', exists: true },
      { from: 'blog', to: 'blog', exists: true },
    ]);
    draft = toggleDatabase(draft, 'blog', false);
    expect(renameRows(draft).map((row) => row.from)).toEqual(['shop']);
  });

  it('accepts the default draft', () => {
    expect(restoreProblemsOf(draftFromInspection(INSPECTION, OPTIONS), INSPECTION)).toEqual([]);
  });

  it('asks for a selection and a tools version', () => {
    let draft = draftFromInspection(INSPECTION, { installedVersions: [] });
    draft = toggleDatabase(toggleDatabase(draft, 'shop', false), 'blog', false);
    expect(restoreProblemsOf(draft, INSPECTION).map((problem) => problem.field)).toEqual([
      'include',
      'toolsVersion',
    ]);
  });

  it('reports rename problems from core', () => {
    let draft = draftFromInspection(INSPECTION, OPTIONS);
    draft = setRename(draft, 'shop', 'blog');
    expect(restoreProblemsOf(draft, INSPECTION)[0]?.field).toBe('renames');
    draft = setRename(setRename(draft, 'shop', 'x'), 'blog', 'x');
    expect(restoreProblemsOf(draft, INSPECTION).some((p) => p.message.includes('Two'))).toBe(true);
    draft = setRename(draft, 'shop', 'admin');
    expect(restoreProblemsOf(draft, INSPECTION).some((p) => p.field === 'renames')).toBe(true);
    draft = setRename(draft, 'shop', '  ');
    expect(restoreProblemsOf(draft, INSPECTION).some((p) => p.field === 'renames')).toBe(true);
  });

  it('applies the option rules from core', () => {
    const base = draftFromInspection(INSPECTION, OPTIONS);
    expect(restoreProblemsOf({ ...base, preserveUUID: true }, INSPECTION)[0]?.field).toBe(
      'preserveUUID',
    );
    expect(restoreProblemsOf({ ...base, oplogReplay: true }, INSPECTION)[0]?.field).toBe(
      'oplogReplay',
    );
    const withOplog = { ...INSPECTION, hasOplog: true };
    expect(restoreProblemsOf({ ...base, oplogReplay: true }, withOplog)).toEqual([]);
    const partial = toggleCollection({ ...base, oplogReplay: true }, 'shop', 'users', false);
    expect(restoreProblemsOf(partial, withOplog)[0]?.field).toBe('oplogReplay');
    expect(restoreProblemsOf({ ...base, restoreDbUsersAndRoles: true }, INSPECTION)[0]?.field).toBe(
      'restoreDbUsersAndRoles',
    );
  });

  it('checks the oplog limit text', () => {
    const base = { ...draftFromInspection(INSPECTION, OPTIONS), oplogLimit: 'soon' };
    expect(restoreProblemsOf(base, INSPECTION)[0]?.field).toBe('oplogLimit');
    const needsReplay = { ...base, oplogLimit: '1700000000:1' };
    expect(restoreProblemsOf(needsReplay, INSPECTION)[0]?.field).toBe('oplogLimit');
  });

  it('builds the start input', () => {
    const draft = draftFromInspection(INSPECTION, OPTIONS);
    const input = restoreStartInput(draft, { connectionId: ID, source: '/backups/shop.archive' });
    expect(input.options.include).toBeUndefined();
    expect(input.options.renames).toEqual([]);
    expect(input.options.oplogLimit).toBeUndefined();
    expect(input.toolsVersion).toBe('100.9.4');
    expect(input.source).toBe('/backups/shop.archive');
    expect(input.acknowledged).toEqual([]);
    expect(input.confirmation).toBeUndefined();
  });

  it('puts the selection, renames, acknowledgements and confirmation in the input', () => {
    let draft = draftFromInspection(INSPECTION, OPTIONS);
    draft = toggleCollection(draft, 'shop', 'users', false);
    draft = setRename(draft, 'blog', 'blog_copy');
    draft = setRename(draft, 'shop', 'shop');
    const input = restoreStartInput(
      { ...draft, drop: true, maintainInsertionOrder: true, numInsertionWorkersPerCollection: 4 },
      { connectionId: ID, source: '/b', acknowledged: ['admin-drop'], confirmation: 'Local' },
    );
    expect(input.options.include).toEqual(['shop.orders', 'blog.*']);
    expect(input.options.renames).toEqual([{ from: 'blog', to: 'blog_copy' }]);
    expect(input.options.drop).toBe(true);
    expect(input.options.stopOnError).toBe(true);
    expect(input.options.numInsertionWorkersPerCollection).toBe(1);
    expect(input.acknowledged).toEqual(['admin-drop']);
    expect(input.confirmation).toBe('Local');
  });
});
