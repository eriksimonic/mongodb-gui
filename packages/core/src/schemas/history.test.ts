import { describe, expect, it } from 'vitest';
import {
  FavouriteInputSchema,
  FavouriteSchema,
  HistoryAppendInputSchema,
  HistoryEntrySchema,
} from './history';

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

  it('accepts an entry without a language, as older entries have none', () => {
    expect(HistoryEntrySchema.parse(entry).language).toBeUndefined();
  });

  it('accepts the mongosh and sql languages', () => {
    expect(HistoryEntrySchema.safeParse({ ...entry, language: 'mongosh' }).success).toBe(true);
    expect(HistoryEntrySchema.safeParse({ ...entry, language: 'sql' }).success).toBe(true);
  });

  it('rejects an unknown language', () => {
    expect(HistoryEntrySchema.safeParse({ ...entry, language: 'cypher' }).success).toBe(false);
  });

  it('keeps the language of a sql entry when parsed', () => {
    const parsed = HistoryEntrySchema.parse({ ...entry, code: 'SELECT 1', language: 'sql' });
    expect(parsed.language).toBe('sql');
  });
});

describe('HistoryAppendInputSchema', () => {
  // An append input is an entry without its id.
  const appendInput = {
    connectionId: entry.connectionId,
    database: entry.database,
    code: entry.code,
    startedAt: entry.startedAt,
    durationMs: entry.durationMs,
  };

  it('carries the language and requires no id', () => {
    const parsed = HistoryAppendInputSchema.parse({ ...appendInput, language: 'sql' });
    expect(parsed.language).toBe('sql');
  });

  it('rejects an entry with an unknown language', () => {
    expect(HistoryAppendInputSchema.safeParse({ ...appendInput, language: 'js' }).success).toBe(
      false,
    );
  });
});

describe('FavouriteSchema', () => {
  it('accepts a favourite with folder and connection scope', () => {
    expect(FavouriteSchema.safeParse(favourite).success).toBe(true);
  });

  it('rejects an empty name', () => {
    expect(FavouriteSchema.safeParse({ ...favourite, name: '' }).success).toBe(false);
  });

  it('accepts a favourite without a language, as older favourites have none', () => {
    expect(FavouriteSchema.parse(favourite).language).toBeUndefined();
  });

  it('keeps the sql language of a favourite', () => {
    const parsed = FavouriteSchema.parse({ ...favourite, language: 'sql' });
    expect(parsed.language).toBe('sql');
  });

  it('rejects an unknown language', () => {
    expect(FavouriteSchema.safeParse({ ...favourite, language: 'bash' }).success).toBe(false);
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

  it('accepts and keeps the language of the input', () => {
    const input = { name: favourite.name, code: 'SELECT 1', language: 'sql' };
    expect(FavouriteInputSchema.parse(input).language).toBe('sql');
  });

  it('rejects input with an unknown language', () => {
    const input = { name: favourite.name, code: favourite.code, language: 'json' };
    expect(FavouriteInputSchema.safeParse(input).success).toBe(false);
  });
});
