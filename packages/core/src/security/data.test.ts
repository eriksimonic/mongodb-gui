import { describe, expect, it } from 'vitest';
import {
  availableOn,
  BUILTIN_ROLES,
  BUILTIN_ROLE_MIN_SERIES,
  PRIVILEGE_ACTIONS,
  PRIVILEGE_ACTION_MIN_SERIES,
  isBuiltinRole,
} from './data';

function duplicates(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      repeated.add(name);
    }
    seen.add(name);
  }
  return [...repeated];
}

describe('built-in roles', () => {
  it('has no duplicate names within or across groups', () => {
    const all: readonly string[] = Object.values(BUILTIN_ROLES).flatMap((names) => names);
    expect(duplicates(all)).toEqual([]);
  });

  it('recognises built-in names and rejects custom ones', () => {
    expect(isBuiltinRole('readWriteAnyDatabase')).toBe(true);
    expect(isBuiltinRole('root')).toBe(true);
    expect(isBuiltinRole('enableSharding')).toBe(true);
    expect(isBuiltinRole('ordersWriter')).toBe(false);
  });

  it('lists only minimum series for names that are built-in roles', () => {
    const all: readonly string[] = Object.values(BUILTIN_ROLES).flatMap((names) => names);
    for (const name of Object.keys(BUILTIN_ROLE_MIN_SERIES)) {
      expect(all).toContain(name);
    }
  });
});

describe('privilege actions', () => {
  it('has no duplicate action names within or across groups', () => {
    const all: readonly string[] = Object.values(PRIVILEGE_ACTIONS).flatMap((names) => names);
    expect(duplicates(all)).toEqual([]);
  });

  it('includes the actions the users and roles screens rely on', () => {
    const all: readonly string[] = Object.values(PRIVILEGE_ACTIONS).flatMap((names) => names);
    for (const action of ['find', 'update', 'createUser', 'grantRole', 'anyAction']) {
      expect(all).toContain(action);
    }
  });

  it('lists every action that has a minimum series', () => {
    const all: readonly string[] = Object.values(PRIVILEGE_ACTIONS).flatMap((names) => names);
    for (const action of Object.keys(PRIVILEGE_ACTION_MIN_SERIES)) {
      expect(all).toContain(action);
    }
  });

  it('keeps the actions that the reported built-in roles use on 8.0.17', () => {
    const all: readonly string[] = Object.values(PRIVILEGE_ACTIONS).flatMap((names) => names);
    for (const action of [
      'dbCheck',
      'netstat',
      'splitVector',
      'replSetResizeOplog',
      'oidcListKeys',
    ]) {
      expect(all).toContain(action);
    }
  });
});

describe('minimum series', () => {
  it('treats a name without a minimum as available on every series', () => {
    expect(availableOn(undefined, '4.4')).toBe(true);
  });

  it('treats a name as available from its minimum series onwards', () => {
    expect(availableOn('6.0', '4.4')).toBe(false);
    expect(availableOn('6.0', '6.0')).toBe(true);
    expect(availableOn('8.0', '6.0')).toBe(false);
    expect(availableOn('8.0', '8.0')).toBe(true);
  });
});
