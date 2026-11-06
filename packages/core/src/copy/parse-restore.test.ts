import { describe, expect, it } from 'vitest';
import { parseRestoreCounts } from './parse-restore';

describe('parseRestoreCounts', () => {
  it('reads the failed count from a timestamped line', () => {
    expect(
      parseRestoreCounts('2024-05-01T10:00:00.000+0000\t3 document(s) failed to restore.'),
    ).toEqual({ failed: 3 });
  });

  it('reads the restored count from its own line', () => {
    expect(parseRestoreCounts('5 document(s) restored successfully.')).toEqual({ restored: 5 });
  });

  it('reads both counts from one line', () => {
    expect(
      parseRestoreCounts('5 document(s) restored successfully. 3 document(s) failed to restore.'),
    ).toEqual({ restored: 5, failed: 3 });
  });

  it('returns nothing for other lines', () => {
    expect(
      parseRestoreCounts('finished restoring `shop.orders` (1 documents, 0 failures)'),
    ).toEqual({});
  });
});
