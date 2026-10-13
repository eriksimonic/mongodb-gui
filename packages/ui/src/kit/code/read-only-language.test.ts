import { describe, expect, it } from 'vitest';
import { LARGE_JSON_CHARS, readOnlyLanguage } from './read-only-language';

describe('readOnlyLanguage', () => {
  it('keeps json for a small text', () => {
    expect(readOnlyLanguage('json', LARGE_JSON_CHARS)).toBe('json');
  });

  it('drops json for a large text', () => {
    expect(readOnlyLanguage('json', LARGE_JSON_CHARS + 1)).toBe('plaintext');
  });

  it('keeps mongosh at any size, because its highlighting needs no worker', () => {
    expect(readOnlyLanguage('mongosh', LARGE_JSON_CHARS * 10)).toBe('mongosh');
  });
});
