import { describe, expect, it } from 'vitest';
import { redactUri } from './redact';

describe('redactUri', () => {
  it('masks the password in a standard uri', () => {
    expect(redactUri('mongodb://app:secret@localhost:27017/shop')).toBe(
      'mongodb://app:***@localhost:27017/shop',
    );
  });

  it('masks the password in an SRV uri', () => {
    expect(redactUri('mongodb+srv://ops:hunter2@cluster0.example.net/?retryWrites=true')).toBe(
      'mongodb+srv://ops:***@cluster0.example.net/?retryWrites=true',
    );
  });

  it('leaves a uri without credentials unchanged', () => {
    const uri = 'mongodb://localhost:27017/?replicaSet=rs0';
    expect(redactUri(uri)).toBe(uri);
  });

  it('leaves a uri with a user but no password unchanged', () => {
    const uri = 'mongodb://app@localhost:27017/';
    expect(redactUri(uri)).toBe(uri);
  });

  it('masks a percent-encoded password', () => {
    expect(redactUri('mongodb://app:p%40ss%3Aword@localhost/')).toBe(
      'mongodb://app:***@localhost/',
    );
  });

  it('masks a password that contains an unencoded at sign or colon', () => {
    expect(redactUri('mongodb://app:p@ss:w@localhost:27017/shop')).toBe(
      'mongodb://app:***@localhost:27017/shop',
    );
  });

  it('does not treat an at sign in the query string as part of the credentials', () => {
    const uri = 'mongodb://localhost/?authMechanismProperties=user:a@b';
    expect(redactUri(uri)).toBe(uri);
  });

  it('returns input that is not a mongo uri unchanged', () => {
    const uri = 'https://app:secret@example.com/';
    expect(redactUri(uri)).toBe(uri);
  });

  it('returns malformed input unchanged', () => {
    expect(redactUri('')).toBe('');
    expect(redactUri('mongodb://')).toBe('mongodb://');
    expect(redactUri('mongodb:/app:secret@host')).toBe('mongodb:/app:secret@host');
    expect(redactUri('mongodb://app:secret')).toBe('mongodb://app:secret');
  });

  it('masks the password when the scheme is in upper case', () => {
    expect(redactUri('MONGODB://app:secret@localhost/')).toBe('MONGODB://app:***@localhost/');
  });
});
