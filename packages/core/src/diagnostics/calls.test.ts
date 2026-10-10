import { describe, expect, it } from 'vitest';
import { KillAllSessionsInputSchema } from './calls';

describe('KillAllSessionsInputSchema', () => {
  it('refuses a user or database name that is only whitespace', () => {
    expect(
      KillAllSessionsInputSchema.safeParse({ users: [{ user: '   ', db: 'admin' }] }).success,
    ).toBe(false);
    expect(
      KillAllSessionsInputSchema.safeParse({ users: [{ user: 'root', db: ' \t ' }] }).success,
    ).toBe(false);
  });

  it('trims a name before it is used', () => {
    const parsed = KillAllSessionsInputSchema.parse({ users: [{ user: ' root ', db: 'admin' }] });
    expect(parsed.users[0]).toEqual({ user: 'root', db: 'admin' });
  });
});
