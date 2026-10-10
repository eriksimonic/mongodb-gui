import { describe, expect, it } from 'vitest';
import type { ConnectionProfileSummary } from '@mongo-gui/core';
import { RECENT_LIMIT, idleLockHint, recentConnections } from './welcome-model';

function summary(name: string, updatedAt: string): ConnectionProfileSummary {
  return {
    id: crypto.randomUUID(),
    name,
    uriRedacted: `mongodb://localhost/${name}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
  };
}

describe('recentConnections', () => {
  it('sorts by the last update, newest first', () => {
    const list = [
      summary('old', '2026-01-01T10:00:00.000Z'),
      summary('new', '2026-03-01T10:00:00.000Z'),
      summary('middle', '2026-02-01T10:00:00.000Z'),
    ];
    expect(recentConnections(list).map((item) => item.name)).toEqual(['new', 'middle', 'old']);
  });

  it('shows at most the limit, five by default', () => {
    const list = Array.from({ length: 8 }, (_, index) =>
      summary(`c${index}`, `2026-01-0${index + 1}T00:00:00.000Z`),
    );
    const shown = recentConnections(list);
    expect(shown).toHaveLength(RECENT_LIMIT);
    expect(shown[0]?.name).toBe('c7');
  });

  it('keeps the list order for equal timestamps and sorts unparsable dates last', () => {
    const list = [
      summary('bad', 'not a date'),
      summary('first', '2026-01-01T00:00:00.000Z'),
      summary('second', '2026-01-01T00:00:00.000Z'),
    ];
    expect(recentConnections(list).map((item) => item.name)).toEqual(['first', 'second', 'bad']);
  });

  it('returns an empty list for no connections', () => {
    expect(recentConnections([])).toEqual([]);
  });
});

describe('idleLockHint', () => {
  it('states the idle lock in minutes', () => {
    expect(idleLockHint(30)).toContain('locks after 30 minutes without activity');
    expect(idleLockHint(1)).toContain('locks after 1 minute without activity');
  });
});
