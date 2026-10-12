import { describe, expect, it } from 'vitest';
import { formatDuration, formatRelative, shortId, unitHint } from './format';

describe('formatRelative', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  it('reads seconds, minutes and hours', () => {
    expect(formatRelative('2026-10-12T11:59:48Z', now)).toBe('12 s ago');
    expect(formatRelative('2026-10-12T11:57:00Z', now)).toBe('3 min ago');
    expect(formatRelative('2026-10-12T09:00:00Z', now)).toBe('3 h ago');
  });
  it('returns the input when it does not parse', () => {
    expect(formatRelative('soon', now)).toBe('soon');
  });
});

describe('shortId', () => {
  it('cuts long ids and keeps short ones', () => {
    expect(shortId('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBe(
      'e3b0c44298fc…',
    );
    expect(shortId('alice')).toBe('alice');
  });
});

describe('formatDuration', () => {
  it('keeps the two largest units', () => {
    expect(formatDuration(13306)).toBe('3 h 41 min');
    expect(formatDuration(90_000)).toBe('1 d 1 h');
    expect(formatDuration(9)).toBe('9 s');
  });
});

describe('unitHint', () => {
  it('reads bytes and uptime keys', () => {
    expect(unitHint('bytes currently in the cache', 5_242_880)).toBe('5.0 MB');
    expect(unitHint('uptimeMillis', 13_306_005)).toBe('3 h 41 min');
    expect(unitHint('pid', 11)).toBeUndefined();
  });
});
