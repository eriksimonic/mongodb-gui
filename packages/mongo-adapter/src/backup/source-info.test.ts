import { describe, expect, it } from 'vitest';
import {
  readFcvValue,
  readStorageEngineName,
  scopeDatabases,
  toNamespaceInfo,
} from './source-info';

describe('toNamespaceInfo', () => {
  it('maps a plain collection', () => {
    expect(toNamespaceInfo('shop', { name: 'orders', type: 'collection' })).toEqual({
      database: 'shop',
      collection: 'orders',
      type: 'collection',
    });
  });

  it('keeps views and time series types', () => {
    expect(toNamespaceInfo('shop', { name: 'v', type: 'view' }).type).toBe('view');
    expect(toNamespaceInfo('shop', { name: 't', type: 'timeseries' }).type).toBe('timeseries');
  });

  it('sets the capped, clustered and encrypted flags from the options', () => {
    expect(
      toNamespaceInfo('shop', {
        name: 'a',
        type: 'collection',
        options: { capped: true, size: 100, clusteredIndex: { key: { _id: 1 } } },
      }),
    ).toMatchObject({ capped: true, clustered: true });
    expect(
      toNamespaceInfo('shop', {
        name: 'b',
        type: 'collection',
        options: { encryptedFields: { fields: [] } },
      }),
    ).toMatchObject({ encrypted: true });
  });

  it('leaves the flags out when they are false', () => {
    const info = toNamespaceInfo('shop', {
      name: 'a',
      type: 'collection',
      options: { capped: false },
    });
    expect(info).not.toHaveProperty('capped');
  });
});

describe('scopeDatabases', () => {
  const all = ['admin', 'local', 'shop'];

  it('skips the local database for the whole server', () => {
    expect(scopeDatabases({ kind: 'server' }, all)).toEqual(['admin', 'shop']);
  });

  it('returns the named databases', () => {
    expect(scopeDatabases({ kind: 'database', database: 'shop' }, all)).toEqual(['shop']);
    expect(scopeDatabases({ kind: 'databases', databases: ['a', 'b'] }, all)).toEqual(['a', 'b']);
    expect(
      scopeDatabases({ kind: 'collection', database: 'shop', collection: 'orders' }, all),
    ).toEqual(['shop']);
  });
});

describe('server reply readers', () => {
  it('reads the feature compatibility version', () => {
    expect(readFcvValue({ featureCompatibilityVersion: { version: '8.0' } })).toBe('8.0');
    expect(readFcvValue({})).toBeUndefined();
  });

  it('reads the storage engine name', () => {
    expect(readStorageEngineName({ storageEngine: { name: 'wiredTiger' } })).toBe('wiredTiger');
    expect(readStorageEngineName({})).toBeUndefined();
  });
});
