import { describe, expect, it, vi } from 'vitest';
import { catalogNamesFrom, type CatalogNameSource } from './catalog';

function source(overrides: Partial<CatalogNameSource> = {}): CatalogNameSource {
  return {
    catalog: vi.fn(() =>
      Promise.reject(Object.assign(new Error('Unrecognized stage'), { code: 40324 })),
    ),
    databaseNames: vi.fn(() => Promise.resolve(['shop', 'locked', 'logs'])),
    collectionNames: vi.fn((db: string) =>
      db === 'locked'
        ? Promise.reject(new Error('not allowed'))
        : Promise.resolve([
            { name: 'orders', type: 'collection' },
            { name: 'system.views', type: 'collection' },
            { name: 'recent', type: 'view' },
          ]),
    ),
    ...overrides,
  };
}

describe('catalogNamesFrom', () => {
  it('groups $listCatalog rows and marks views and time series', async () => {
    const result = await catalogNamesFrom(
      source({
        catalog: () =>
          Promise.resolve([
            { db: 'shop', name: 'orders', type: 'collection' },
            { db: 'shop', name: 'recent', type: 'view' },
            {
              db: 'shop',
              name: 'metrics',
              type: 'collection',
              md: { options: { timeseries: {} } },
            },
            { db: 'admin', name: 'system.users', type: 'collection' },
          ]),
      }),
    );
    expect(result.databases.map((db) => db.name)).toEqual(['shop']);
    expect(result.databases[0]?.collections).toEqual([
      { name: 'metrics', type: 'timeseries' },
      { name: 'orders', type: 'collection' },
      { name: 'recent', type: 'view' },
    ]);
  });

  it('falls back on code 40324, skips failing databases, and remembers the refusal', async () => {
    const memo = { unsupported: false };
    const src = source();
    const first = await catalogNamesFrom(src, memo);
    expect(first.databases.map((db) => db.name)).toEqual(['logs', 'shop']);
    expect(first.databases[0]?.collections.map((c) => c.name)).toEqual(['orders', 'recent']);
    expect(memo.unsupported).toBe(true);
    await catalogNamesFrom(src, memo);
    expect(src.catalog).toHaveBeenCalledTimes(1);
  });

  it('limits the fallback to eight databases at a time', async () => {
    let running = 0;
    let peak = 0;
    const names = Array.from({ length: 20 }, (_, index) => `db${index}`);
    await catalogNamesFrom(
      source({
        databaseNames: () => Promise.resolve(names),
        collectionNames: async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 1));
          running -= 1;
          return [];
        },
      }),
    );
    expect(peak).toBeLessThanOrEqual(8);
  });
});
