import { describe, expect, it } from 'vitest';
import { FavouriteInputSchema, FavouriteSchema, HistoryEntrySchema } from './history';

const entry = {
  id: '9b1d4c7a-2e3f-4a6b-8c9d-0e1f2a3b4c5d',
  connectionId: '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10',
  database: 'shop',
  code: 'db.orders.find({ status: "paid" }).limit(50)',
  startedAt: '2026-10-05T08:15:00.000Z',
  durationMs: 42,
  resultCount: 50,
};

const favourite = {
  id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  name: 'Paid orders',
  folder: 'Orders',
  code: 'db.orders.find({ status: "paid" })',
  connectionId: entry.connectionId,
  database: 'shop',
  createdAt: '2026-10-05T09:00:00.000Z',
};

describe('HistoryEntrySchema', () => {
  it('accepts an entry with a result count and no error', () => {
    expect(HistoryEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts a failed entry carrying an AppError', () => {
    const failed = {
      ...entry,
      resultCount: undefined,
      error: { code: 'COMMAND_FAILED', message: 'Unknown operator' },
    };
    expect(HistoryEntrySchema.safeParse(failed).success).toBe(true);
  });

  it('rejects a negative duration', () => {
    expect(HistoryEntrySchema.safeParse({ ...entry, durationMs: -1 }).success).toBe(false);
  });
});

describe('FavouriteSchema', () => {
  it('accepts a favourite with folder and connection scope', () => {
    expect(FavouriteSchema.safeParse(favourite).success).toBe(true);
  });

  it('rejects an empty name', () => {
    expect(FavouriteSchema.safeParse({ ...favourite, name: '' }).success).toBe(false);
  });
});

describe('FavouriteInputSchema', () => {
  it('accepts input without id and createdAt', () => {
    const input = { name: favourite.name, code: favourite.code };
    expect(FavouriteInputSchema.safeParse(input).success).toBe(true);
  });

  it('rejects input with a malformed connection id', () => {
    const input = { name: favourite.name, code: favourite.code, connectionId: 'abc' };
    expect(FavouriteInputSchema.safeParse(input).success).toBe(false);
  });
});
