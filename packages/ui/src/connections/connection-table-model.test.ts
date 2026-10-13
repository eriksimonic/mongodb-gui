import { describe, expect, it } from 'vitest';
import type { ConnectionProfileSummary } from '@mongo-gui/core';
import {
  EMPTY_FILTERS,
  formatAge,
  securityText,
  serverText,
  visibleConnections,
} from './connection-table-model';

function connection(
  name: string,
  uriRedacted: string,
  extra: Partial<ConnectionProfileSummary> = {},
): ConnectionProfileSummary {
  return {
    id: name,
    name,
    uriRedacted,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

describe('serverText', () => {
  it('drops the user info and the options', () => {
    expect(serverText(connection('a', 'mongodb://u:***@h1:1,h2:2/db?tls=true'))).toBe('h1:1,h2:2');
    expect(serverText(connection('a', 'mongodb://localhost:27017'))).toBe('localhost:27017');
  });
  it('keeps the scheme of a +srv URI', () => {
    expect(serverText(connection('a', 'mongodb+srv://u:***@c0.example.net/db'))).toBe(
      'mongodb+srv://c0.example.net',
    );
  });
});

describe('securityText', () => {
  it('is empty without a user, TLS or mechanism', () => {
    expect(securityText(connection('a', 'mongodb://localhost:27017'))).toBe('');
  });
  it('shows the user and the authentication database', () => {
    expect(securityText(connection('a', 'mongodb://writer:***@h/?authSource=admin'))).toBe(
      'writer @ admin',
    );
    expect(securityText(connection('a', 'mongodb://writer:***@h/app'))).toBe('writer @ admin');
  });
  it('tags TLS and a special mechanism', () => {
    expect(
      securityText(
        connection('a', 'mongodb://u@h/?authMechanism=MONGODB-OIDC', { tls: { enabled: true } }),
      ),
    ).toBe('[SSL] [OIDC] u @ admin');
  });
});

describe('formatAge', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  it('reads each range', () => {
    expect(formatAge(undefined, now)).toBe('Never');
    expect(formatAge('2026-10-12T11:59:40Z', now)).toBe('just now');
    expect(formatAge('2026-10-12T11:55:00Z', now)).toBe('5 min ago');
    expect(formatAge('2026-10-12T09:00:00Z', now)).toBe('3 h ago');
    expect(formatAge('2026-10-06T12:00:00Z', now)).toBe('6 days ago');
    expect(formatAge('2026-08-01T12:00:00Z', now)).toBe('2 months ago');
    expect(formatAge('2024-10-01T12:00:00Z', now)).toBe('2 years ago');
  });
});

describe('visibleConnections', () => {
  const rows = [
    connection('alpha', 'mongodb://localhost:27017', {
      lastAccessedAt: '2026-10-01T00:00:00.000Z',
    }),
    connection('beta', 'mongodb://u:***@db.example.net', {
      lastAccessedAt: '2026-10-10T00:00:00.000Z',
    }),
    connection('gamma', 'mongodb://localhost:28000'),
  ];
  it('sorts newest first and puts never last', () => {
    const sorted = visibleConnections(rows, EMPTY_FILTERS, {
      column: 'lastAccessed',
      direction: 'desc',
    });
    expect(sorted.map((row) => row.name)).toEqual(['beta', 'alpha', 'gamma']);
  });
  it('filters by text in a column, ignoring case', () => {
    const found = visibleConnections(
      rows,
      { ...EMPTY_FILTERS, server: 'LOCALHOST' },
      { column: 'name', direction: 'asc' },
    );
    expect(found.map((row) => row.name)).toEqual(['alpha', 'gamma']);
  });
});
