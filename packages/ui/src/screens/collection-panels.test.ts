import { describe, expect, it } from 'vitest';
import type { PanelRequest } from '../state/app-store';
import { catalogKey } from '../state/node-ids';
import {
  databasePanelIds,
  isStalePanel,
  restoredCollectionRequest,
  stalePanelIds,
} from './collection-panels';

const CONNECTION = 'c1';
const orders: PanelRequest = {
  panel: 'documents',
  connectionId: CONNECTION,
  database: 'shop',
  collection: 'orders',
};
const customers: PanelRequest = { ...orders, panel: 'indexes', collection: 'customers' };
const logs: PanelRequest = { ...orders, database: 'logs', collection: 'app_logs' };

const databases = {
  [CONNECTION]: {
    state: 'ready' as const,
    data: [{ name: 'shop' }, { name: 'logs' }],
  },
};
const collections = {
  [catalogKey(CONNECTION, 'shop')]: {
    state: 'ready' as const,
    data: [{ name: 'orders', type: 'collection' as const }],
  },
};

describe('isStalePanel', () => {
  it('keeps a panel whose database and collection are both listed', () => {
    expect(isStalePanel(orders, databases, collections)).toBe(false);
  });

  it('closes a panel whose collection was renamed or dropped', () => {
    expect(isStalePanel({ ...orders, collection: 'renamed' }, databases, collections)).toBe(true);
    expect(isStalePanel(customers, databases, collections)).toBe(true);
  });

  it('closes a panel whose database is no longer in the loaded database list', () => {
    const dropped = { [CONNECTION]: { state: 'ready' as const, data: [{ name: 'logs' }] } };
    expect(isStalePanel(orders, dropped, collections)).toBe(true);
  });

  it('keeps a panel while its database list is still loading', () => {
    const loading = { [CONNECTION]: { state: 'loading' as const } };
    expect(isStalePanel(orders, loading, {})).toBe(false);
  });

  it('keeps a panel whose collection list has not loaded, even when its database is unexpanded', () => {
    expect(isStalePanel(logs, databases, {})).toBe(false);
  });
});

describe('stalePanelIds', () => {
  it('returns only the panels that are stale', () => {
    const open = new Map<string, PanelRequest>([
      ['orders', orders],
      ['renamed', { ...orders, collection: 'renamed' }],
      ['logs', logs],
    ]);
    expect(stalePanelIds(open, databases, collections)).toEqual(['renamed']);
  });
});

describe('databasePanelIds', () => {
  it('returns every collection panel of the dropped database and no other', () => {
    const open = new Map<string, PanelRequest>([
      ['orders', orders],
      ['customers', customers],
      ['logs', logs],
    ]);
    expect(databasePanelIds(open, CONNECTION, 'shop')).toEqual(['orders', 'customers']);
    expect(databasePanelIds(open, 'other', 'shop')).toEqual([]);
  });
});

describe('restoredCollectionRequest', () => {
  it('reads a collection panel request from the params of a restored dock panel', () => {
    expect(
      restoredCollectionRequest('schema', {
        connectionId: CONNECTION,
        database: 'shop',
        collection: 'orders',
      }),
    ).toEqual({
      panel: 'schema',
      connectionId: CONNECTION,
      database: 'shop',
      collection: 'orders',
    });
  });

  it('ignores panels that are not collection panels and params that lack a name', () => {
    const params = { connectionId: CONNECTION, database: 'shop', collection: 'orders' };
    expect(restoredCollectionRequest('monitor', params)).toBeUndefined();
    expect(restoredCollectionRequest('profiler', params)).toBeUndefined();
    expect(restoredCollectionRequest('documents', { connectionId: CONNECTION })).toBeUndefined();
    expect(restoredCollectionRequest('documents', undefined)).toBeUndefined();
  });
});
