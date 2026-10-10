import { describe, expect, it } from 'vitest';
import { isSelfRevokeOfUserAdmin } from './self-revoke';

const ME = { user: 'siteAdmin', db: 'admin' };
const SIGNED_IN = [ME];

describe('isSelfRevokeOfUserAdmin', () => {
  it('flags a revoke of a user-admin role from the signed-in account', () => {
    expect(
      isSelfRevokeOfUserAdmin(SIGNED_IN, ME, [{ role: 'userAdminAnyDatabase', db: 'admin' }]),
    ).toBe(true);
    expect(isSelfRevokeOfUserAdmin(SIGNED_IN, ME, [{ role: 'userAdmin', db: 'shop' }])).toBe(true);
  });

  it('does not flag a revoke of other roles, or of another user', () => {
    expect(isSelfRevokeOfUserAdmin(SIGNED_IN, ME, [{ role: 'readWrite', db: 'shop' }])).toBe(false);
    expect(
      isSelfRevokeOfUserAdmin(SIGNED_IN, { user: 'reporter', db: 'shop' }, [
        { role: 'userAdminAnyDatabase', db: 'admin' },
      ]),
    ).toBe(false);
  });

  it('needs the same database as well as the same name', () => {
    expect(
      isSelfRevokeOfUserAdmin(SIGNED_IN, { user: 'siteAdmin', db: 'shop' }, [
        { role: 'userAdmin', db: 'shop' },
      ]),
    ).toBe(false);
  });

  it('is false when nothing is signed in', () => {
    expect(isSelfRevokeOfUserAdmin([], ME, [{ role: 'userAdmin', db: 'admin' }])).toBe(false);
  });
});
