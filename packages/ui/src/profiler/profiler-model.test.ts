import { describe, expect, it } from 'vitest';
import { groupByShape, shapeKey, type ProfileEntry } from '@mongo-gui/core';
import {
  DEFAULT_FILTERS,
  DEFAULT_LEVEL_DRAFT,
  draftFromLevel,
  durationPercent,
  entriesOfShape,
  examinedRatio,
  filtersToQuery,
  formatBytes,
  commandPreview,
  userCommand,
  formatCommand,
  formatCommandJson,
  formatLocalTime,
  isCollscan,
  isDraftDirty,
  levelFromText,
  mergeTailEntries,
  parseLocalTime,
  setLevelInput,
  sortEntries,
  tailFilterFor,
  toggleSort,
  type ProfilerFilters,
} from './profiler-model';

const NOW = new Date('2026-10-09T10:00:00.000Z');

function entry(id: string, overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return {
    id,
    ts: '2026-10-09T09:59:00.000Z',
    ns: 'shop.orders',
    op: 'query',
    millis: 100,
    command: { find: 'orders', filter: { status: 'paid' } },
    raw: {},
    ...overrides,
  };
}

describe('filtersToQuery', () => {
  it('maps an empty filter row to the default limit and nothing else', () => {
    expect(filtersToQuery(DEFAULT_FILTERS, NOW)).toEqual({ limit: 200 });
  });

  it('maps the namespace, operation, duration and text search, trimming text', () => {
    const filters: ProfilerFilters = {
      ...DEFAULT_FILTERS,
      namespace: ' shop.orders ',
      op: 'update',
      minMillis: 50,
      textSearch: ' status ',
      limit: 20,
    };
    expect(filtersToQuery(filters, NOW)).toEqual({
      ns: 'shop.orders',
      op: 'update',
      minMillis: 50,
      textSearch: 'status',
      limit: 20,
    });
  });

  it('drops a zero or empty duration and blank text', () => {
    const filters = { ...DEFAULT_FILTERS, minMillis: 0, namespace: '  ', textSearch: '   ' };
    expect(filtersToQuery(filters, NOW)).toEqual({ limit: 200 });
  });

  it('measures the relative ranges back from now', () => {
    expect(filtersToQuery({ ...DEFAULT_FILTERS, range: '5m' }, NOW)).toEqual({
      limit: 200,
      since: '2026-10-09T09:55:00.000Z',
    });
    expect(filtersToQuery({ ...DEFAULT_FILTERS, range: '1h' }, NOW).since).toBe(
      '2026-10-09T09:00:00.000Z',
    );
  });

  it('uses the custom since and until only for the custom range', () => {
    const custom = {
      ...DEFAULT_FILTERS,
      range: 'custom' as const,
      since: '2026-10-09T09:00',
      until: '2026-10-09T09:30',
    };
    const query = filtersToQuery(custom, NOW);
    expect(query.since).toBe(new Date('2026-10-09T09:00').toISOString());
    expect(query.until).toBe(new Date('2026-10-09T09:30').toISOString());

    const ignored = { ...custom, range: 'all' as const };
    expect(filtersToQuery(ignored, NOW)).toEqual({ limit: 200 });
  });

  it('clamps the limit to the contract range', () => {
    expect(filtersToQuery({ ...DEFAULT_FILTERS, limit: 0 }, NOW).limit).toBe(1);
    expect(filtersToQuery({ ...DEFAULT_FILTERS, limit: 99_999 }, NOW).limit).toBe(5000);
    expect(filtersToQuery({ ...DEFAULT_FILTERS, limit: Number.NaN }, NOW).limit).toBe(200);
  });
});

describe('tailFilterFor', () => {
  it('leaves the time range out, because a tail only delivers new entries', () => {
    const filters = { ...DEFAULT_FILTERS, range: '5m' as const, namespace: 'shop.orders' };
    expect(tailFilterFor(filters, NOW)).toEqual({ limit: 200, ns: 'shop.orders' });
  });
});

describe('parseLocalTime', () => {
  it('returns undefined for an empty or invalid value', () => {
    expect(parseLocalTime('')).toBeUndefined();
    expect(parseLocalTime('not a time')).toBeUndefined();
  });
});

describe('mergeTailEntries', () => {
  it('puts new entries first, newest first, and reports their ids', () => {
    const current = [entry('a', { ts: '2026-10-09T09:58:00.000Z' })];
    const incoming = [
      entry('c', { ts: '2026-10-09T09:59:30.000Z' }),
      entry('b', { ts: '2026-10-09T09:59:00.000Z' }),
    ];
    const merged = mergeTailEntries(current, incoming, 200);
    expect(merged.entries.map((item) => item.id)).toEqual(['c', 'b', 'a']);
    expect(merged.added).toEqual(['c', 'b']);
  });

  it('skips entries already listed, even when they arrive again', () => {
    const current = [entry('a')];
    const merged = mergeTailEntries(current, [entry('a'), entry('a')], 200);
    expect(merged.entries).toHaveLength(1);
    expect(merged.added).toEqual([]);
  });

  it('keeps at most the limit and drops the oldest rows', () => {
    const current = [
      entry('old', { ts: '2026-10-09T09:00:00.000Z' }),
      entry('older', { ts: '2026-10-09T08:00:00.000Z' }),
    ];
    const merged = mergeTailEntries(current, [entry('new', { ts: '2026-10-09T09:30:00.000Z' })], 2);
    expect(merged.entries.map((item) => item.id)).toEqual(['new', 'old']);
  });

  it('returns the current rows unchanged when nothing is new', () => {
    const current = [entry('a')];
    const merged = mergeTailEntries(current, [], 200);
    expect(merged).toEqual({ entries: current, added: [] });
    expect(merged.entries).not.toBe(current);
  });
});

describe('sortEntries and toggleSort', () => {
  const rows = [
    entry('fast', { ts: '2026-10-09T09:00:00.000Z', millis: 5 }),
    entry('slow', { ts: '2026-10-09T08:00:00.000Z', millis: 900 }),
    entry('mid', { ts: '2026-10-09T09:30:00.000Z', millis: 50 }),
  ];

  it('sorts by time descending by default', () => {
    expect(sortEntries(rows, { key: 'time', direction: 'desc' }).map((row) => row.id)).toEqual([
      'mid',
      'fast',
      'slow',
    ]);
  });

  it('sorts by duration in both directions', () => {
    expect(sortEntries(rows, { key: 'duration', direction: 'desc' }).map((row) => row.id)).toEqual([
      'slow',
      'mid',
      'fast',
    ]);
    expect(sortEntries(rows, { key: 'duration', direction: 'asc' }).map((row) => row.id)).toEqual([
      'fast',
      'mid',
      'slow',
    ]);
  });

  it('flips the direction of the same column and starts a new column descending', () => {
    const byTime = { key: 'time', direction: 'desc' } as const;
    expect(toggleSort(byTime, 'time')).toEqual({ key: 'time', direction: 'asc' });
    expect(toggleSort(byTime, 'duration')).toEqual({ key: 'duration', direction: 'desc' });
  });
});

describe('shape helpers', () => {
  it('keeps the rows of one shape by the shape key of core', () => {
    const rows = [
      entry('a', { queryHash: 'H1' }),
      entry('b', { queryHash: 'H1' }),
      entry('c', { queryHash: 'H2' }),
    ];
    const key = shapeKey(rows[0] ?? entry('x'));
    expect(entriesOfShape(rows, key).map((row) => row.id)).toEqual(['a', 'b']);
    expect(groupByShape(rows).map((shape) => shape.count)).toEqual([2, 1]);
  });
});

describe('display helpers', () => {
  it('finds COLLSCAN in a plan summary', () => {
    expect(isCollscan('COLLSCAN')).toBe(true);
    expect(isCollscan('IXSCAN { status: 1 }')).toBe(false);
    expect(isCollscan(undefined)).toBe(false);
  });

  it('divides examined documents by returned documents', () => {
    expect(examinedRatio(entry('a', { docsExamined: 1200, nreturned: 50 }))).toBe(24);
    expect(examinedRatio(entry('b', { docsExamined: 7, nreturned: 0 }))).toBe(7);
    expect(examinedRatio(entry('c'))).toBeUndefined();
  });

  it('sizes a duration bar against the slowest row in view', () => {
    expect(durationPercent(50, 200)).toBe(25);
    expect(durationPercent(300, 200)).toBe(100);
    expect(durationPercent(10, 0)).toBe(0);
  });

  it('formats a command as indented mongosh source and an absent command as empty text', () => {
    expect(formatCommand({ find: 'orders' })).toBe('{\n  find: "orders"\n}');
    expect(formatCommand(undefined)).toBe('');
  });

  it('writes canonical wrappers as mongosh constructors in the command text', () => {
    const command = {
      find: 'orders',
      limit: { $numberInt: '20' },
      at: { $date: { $numberLong: '0' } },
    };
    expect(formatCommand(command, 0)).toBe(
      '{find: "orders", limit: 20, at: ISODate("1970-01-01T00:00:00.000Z")}',
    );
  });

  it('formats the JSON view with numbers and dates as plain JSON', () => {
    const command = { limit: { $numberInt: '20' }, at: { $date: { $numberLong: '0' } } };
    expect(JSON.parse(formatCommandJson(command))).toEqual({
      limit: 20,
      at: '1970-01-01T00:00:00.000Z',
    });
  });

  it('shortens a one-line command preview with an ellipsis', () => {
    const long = { filter: { name: 'x'.repeat(200) } };
    const preview = commandPreview(long);
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.length).toBe(120);
    expect(commandPreview({ find: 'orders' })).toBe('{find: "orders"}');
  });

  it('formats a local time with milliseconds', () => {
    const iso = '2026-10-09T10:00:00.007Z';
    expect(formatLocalTime(iso)).toMatch(/^\d{2}:\d{2}:\d{2}\.007$/);
  });

  it('leaves the driver session fields out of the command a copy or the editor gets', () => {
    const command = {
      find: 'orders',
      lsid: { id: 'session' },
      $db: 'shop',
      $clusterTime: { clusterTime: 1 },
      $readPreference: { mode: 'primaryPreferred' },
      $readConcern: { level: 'local' },
    };
    expect(userCommand(command)).toEqual({ find: 'orders', $readConcern: { level: 'local' } });
    expect(userCommand('plain')).toBe('plain');
    expect(formatCommand(userCommand(command), 0)).toBe(
      '{find: "orders", $readConcern: {level: "local"}}',
    );
  });

  it('formats byte counts', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
  });
});

describe('level draft', () => {
  it('reads the level control value and treats anything else as off', () => {
    expect(levelFromText('1')).toBe(1);
    expect(levelFromText('2')).toBe(2);
    expect(levelFromText('0')).toBe(0);
    expect(levelFromText('x')).toBe(0);
  });

  it('is dirty when the level differs, or when the threshold differs at level 1', () => {
    const server = { level: 1 as const, slowMs: 100, sampleRate: 1 };
    expect(isDraftDirty(draftFromLevel(server), server)).toBe(false);
    expect(isDraftDirty({ ...DEFAULT_LEVEL_DRAFT, level: 2 }, server)).toBe(true);
    expect(isDraftDirty({ level: 1, slowMs: 250, sampleRate: 1 }, server)).toBe(true);
    expect(isDraftDirty(DEFAULT_LEVEL_DRAFT, undefined)).toBe(true);
  });

  it('sends the threshold and sample rate only at level 1', () => {
    expect(setLevelInput({ level: 1, slowMs: 50, sampleRate: 0.5 })).toEqual({
      level: 1,
      slowMs: 50,
      sampleRate: 0.5,
    });
    expect(setLevelInput({ level: 2, slowMs: 50, sampleRate: 0.5 })).toEqual({ level: 2 });
  });
});
