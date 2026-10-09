import { describe, expect, it } from 'vitest';
import { redactPassword } from './redact';

const SECRET = 'hunter2-secret';

describe('redactPassword', () => {
  it('masks a known password of eight characters or more wherever it appears', () => {
    expect(redactPassword(`refused for ${SECRET} and again ${SECRET}`, SECRET)).toBe(
      'refused for *** and again ***',
    );
  });

  it.each([
    ['unquoted in shell style', `{ createUser: "clerk", pwd: ${SECRET} }`],
    ['double quoted JSON', `{"createUser": "clerk", "pwd": "${SECRET}"}`],
    ['single quoted', `{ pwd: '${SECRET}' }`],
    ['with an escaped quote', `{"pwd": "a\\"b c"}`],
    ['a password field', `{"password": "${SECRET}"}`],
  ])('masks a pwd or password field %s', (_label, text) => {
    const redacted = redactPassword(text);
    expect(redacted).not.toContain(SECRET);
    expect(redacted).not.toContain('a\\"b c');
    expect(redacted).toMatch(/pwd|password/);
    expect(redacted).toContain('***');
  });

  it('masks a seven character password in a pwd field but not in free text', () => {
    const shortSecret = 'abc1234';
    expect(redactPassword(`pwd: "${shortSecret}"`, shortSecret)).toBe('pwd: "***"');
    expect(redactPassword(`contains abc1234 here`, shortSecret)).toBe('contains abc1234 here');
  });

  it('does not mask a one character password by value', () => {
    expect(redactPassword('a plain a text', 'a')).toBe('a plain a text');
  });

  it('leaves text without a password unchanged', () => {
    const text = 'not authorized on shop to execute command';
    expect(redactPassword(text)).toBe(text);
  });

  it('ignores an empty password', () => {
    expect(redactPassword('plain text', '')).toBe('plain text');
  });
});
