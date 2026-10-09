import { AppErrorException, type AppErrorCode, type HistoryEntry } from '@mongo-gui/core';
import { afterEach, describe, expect, it } from 'vitest';
import { connectionInput, openTestStore, type TestStore } from './fixtures';

let test: TestStore;
let connectionId: string;

afterEach(() => {
  test.dispose();
});

function codeOf(action: () => unknown): AppErrorCode | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof AppErrorException ? error.error.code : undefined;
  }
}

function minute(offset: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, offset)).toISOString();
}

function entry(
  overrides: Partial<Omit<HistoryEntry, 'id'>> & Pick<HistoryEntry, 'code' | 'startedAt'>,
): Omit<HistoryEntry, 'id'> {
  return { connectionId, database: 'app', durationMs: 5, ...overrides };
}

function setUp(): void {
  test = openTestStore();
  connectionId = test.connections.create(connectionInput()).id;
}

describe('HistoryRepository.append', () => {
  it('assigns an id and normalises startedAt to millisecond precision', () => {
    setUp();
    const appended = test.history.append(
      entry({ code: 'db.a.find()', startedAt: '2026-01-01T00:00:00Z' }),
    );
    expect(appended.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(appended.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(test.history.list()).toEqual([appended]);
  });

  it('keeps the optional error and result count', () => {
    setUp();
    const appended = test.history.append(
      entry({
        code: 'db.a.find()',
        startedAt: minute(1),
        resultCount: 3,
        error: { code: 'COMMAND_FAILED', message: 'failed' },
      }),
    );
    expect(test.history.list()[0]).toEqual(appended);
  });

  it('rejects input that fails the schema with VALIDATION', () => {
    setUp();
    expect(
      codeOf(() =>
        test.history.append(entry({ code: 1 as unknown as string, startedAt: minute(1) })),
      ),
    ).toBe('VALIDATION');
  });

  it('throws CONNECTION_NOT_FOUND for an unknown connection', () => {
    setUp();
    expect(
      codeOf(() =>
        test.history.append({
          ...entry({ code: 'x', startedAt: minute(1) }),
          connectionId: '00000000-0000-4000-8000-000000000000',
        }),
      ),
    ).toBe('CONNECTION_NOT_FOUND');
  });
});

describe('HistoryRepository.list', () => {
  it('returns entries newest first', () => {
    setUp();
    test.history.append(entry({ code: 'old', startedAt: minute(1) }));
    test.history.append(entry({ code: 'new', startedAt: minute(3) }));
    test.history.append(entry({ code: 'middle', startedAt: minute(2) }));
    expect(test.history.list().map((item) => item.code)).toEqual(['new', 'middle', 'old']);
  });

  it('filters by connection', () => {
    setUp();
    const other = test.connections.create(connectionInput({ name: 'Other' })).id;
    test.history.append(entry({ code: 'mine', startedAt: minute(1) }));
    test.history.append({
      ...entry({ code: 'theirs', startedAt: minute(2) }),
      connectionId: other,
    });
    expect(test.history.list({ connectionId }).map((item) => item.code)).toEqual(['mine']);
  });

  it('searches the decrypted code case-insensitively as a substring', () => {
    setUp();
    test.history.append(entry({ code: 'db.Orders.find({status: "PAID"})', startedAt: minute(1) }));
    test.history.append(entry({ code: 'db.users.count()', startedAt: minute(2) }));
    expect(test.history.list({ search: 'paid' }).map((item) => item.code)).toEqual([
      'db.Orders.find({status: "PAID"})',
    ]);
    expect(test.history.list({ search: 'USERS.COUNT' })).toHaveLength(1);
    expect(test.history.list({ search: 'nothing-matches' })).toEqual([]);
  });

  it('applies limit after the search filter', () => {
    setUp();
    test.history.append(entry({ code: 'find a', startedAt: minute(1) }));
    test.history.append(entry({ code: 'count b', startedAt: minute(2) }));
    test.history.append(entry({ code: 'find c', startedAt: minute(3) }));
    expect(test.history.list({ limit: 1 }).map((item) => item.code)).toEqual(['find c']);
    expect(test.history.list({ search: 'find', limit: 5 }).map((item) => item.code)).toEqual([
      'find c',
      'find a',
    ]);
    expect(test.history.list({ search: 'find', limit: 1 }).map((item) => item.code)).toEqual([
      'find c',
    ]);
  });

  it('rejects a limit below one with VALIDATION', () => {
    setUp();
    expect(codeOf(() => test.history.list({ limit: 0 }))).toBe('VALIDATION');
  });
});

describe('HistoryRepository.clear', () => {
  it('removes every entry', () => {
    setUp();
    test.history.append(entry({ code: 'a', startedAt: minute(1) }));
    test.history.clear();
    expect(test.history.list()).toEqual([]);
  });
});

describe('HistoryRepository.prune', () => {
  it('keeps exactly the limit newest entries when the history limit setting is applied', () => {
    setUp();
    test.settings.update({ historyLimit: 3 });
    for (let index = 1; index <= 5; index += 1) {
      test.history.append(entry({ code: `q${index}`, startedAt: minute(index) }));
    }
    expect(test.history.list().map((item) => item.code)).toEqual(['q5', 'q4', 'q3']);
  });

  it('deletes the oldest rows beyond the limit and reports how many it removed', () => {
    setUp();
    for (let index = 1; index <= 4; index += 1) {
      test.history.append(entry({ code: `q${index}`, startedAt: minute(index) }));
    }
    expect(test.history.prune(2)).toBe(2);
    expect(test.history.list().map((item) => item.code)).toEqual(['q4', 'q3']);
    expect(test.history.prune(10)).toBe(0);
  });

  it('rejects a limit below one with VALIDATION', () => {
    setUp();
    expect(codeOf(() => test.history.prune(0))).toBe('VALIDATION');
  });
});

describe('history rows of a removed connection', () => {
  it('are removed with the connection', () => {
    setUp();
    test.history.append(entry({ code: 'gone', startedAt: minute(1) }));
    test.connections.remove(connectionId);
    const remaining = test.store.db.prepare('SELECT COUNT(*) AS count FROM history').get();
    expect(remaining?.['count']).toBe(0);
  });
});

describe('HistoryRepository.append at the limit', () => {
  it('keeps every row when the count equals the limit', () => {
    setUp();
    test.settings.update({ historyLimit: 2 });
    test.history.append(entry({ code: 'q1', startedAt: minute(1) }));
    test.history.append(entry({ code: 'q2', startedAt: minute(2) }));
    expect(test.history.list()).toHaveLength(2);
    test.history.append(entry({ code: 'q3', startedAt: minute(3) }));
    expect(test.history.list().map((item) => item.code)).toEqual(['q3', 'q2']);
  });
});
