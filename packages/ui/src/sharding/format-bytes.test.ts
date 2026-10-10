import { describe, expect, it } from 'vitest';
import { formatBytes } from './format-bytes';

describe('formatBytes', () => {
  it('uses bytes below 1 KB and one decimal above', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2_150_000)).toBe('2.1 MB');
    expect(formatBytes(1024 * 1024 * 1024 * 3)).toBe('3.0 GB');
  });
});
