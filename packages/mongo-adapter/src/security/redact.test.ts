import { describe, expect, it } from 'vitest';
import { redactPassword } from './redact';

const SECRET = 'hunter2-secret';

describe('redactPassword', () => {
  it('masks a known password wherever it appears', () => {
    expect(redactPassword(`refused for ${SECRET} and again ${SECRET}`, SECRET)).toBe(
      'refused for *** and again ***',
    );
  });

  it.each([
    ['unquoted in shell style', `{ createUser: "clerk", pwd: ${SECRET} }`],
    ['double quoted JSON', `{"createUser": "clerk", "pwd": "${SECRET}"}`],
    ['single quoted', `{ pwd: '${SECRET}' }`],
    ['with an escaped quote', `{"pwd": "a\\"b c"}`],
  ])('masks a pwd field %s', (_label, text) => {
    const redacted = redactPassword(text);
    expect(redacted).not.toContain(SECRET);
    expect(redacted).not.toContain('a\\"b c');
    expect(redacted).toContain('pwd');
    expect(redacted).toContain('***');
  });

  it('leaves text without a password unchanged', () => {
    const text = 'not authorized on shop to execute command';
    expect(redactPassword(text)).toBe(text);
  });

  it('ignores an empty password instead of masking every position', () => {
    expect(redactPassword('plain text', '')).toBe('plain text');
  });
});
