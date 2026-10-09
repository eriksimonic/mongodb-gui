import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES, PRIVILEGE_ACTIONS, isBuiltinRole } from './data';

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
    expect(isBuiltinRole('ordersWriter')).toBe(false);
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
});
