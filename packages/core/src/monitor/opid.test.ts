import { describe, expect, it } from 'vitest';
import { isSyntheticOpid } from './opid';

describe('isSyntheticOpid', () => {
  it('flags idle connection placeholders', () => {
    expect(isSyntheticOpid('conn:42')).toBe(true);
  });

  it('keeps real server opids killable', () => {
    expect(isSyntheticOpid(1234)).toBe(false);
    expect(isSyntheticOpid('shard01:99')).toBe(false);
    expect(isSyntheticOpid('conn:')).toBe(false);
    expect(isSyntheticOpid('conn:4a')).toBe(false);
  });
});
