import { describe, expect, it } from 'vitest';
import type { ProfileEntry } from '@mongo-gui/core';
import { labelOccurrences } from './profiler';

const TS = '2026-10-09T10:00:00.000Z';

function row(id: string, ts = TS): ProfileEntry {
  return { id, ts, ns: 'shop.orders', op: 'query', millis: 5, raw: {} };
}

describe('labelOccurrences', () => {
  it('suffixes repeats of one base id with their occurrence index', () => {
    const labelled = labelOccurrences([row('X'), row('X')]);
    expect(labelled.map((entry) => entry.id)).toEqual(['X', 'X~1']);
  });

  it('labels the same batch the same way whatever order the server returned it in', () => {
    const forward = labelOccurrences([row('X'), row('X'), row('Y')]);
    const backward = labelOccurrences([row('Y'), row('X'), row('X')]);
    expect(forward.map((entry) => entry.id).sort()).toEqual(['X', 'X~1', 'Y']);
    expect(backward.map((entry) => entry.id).sort()).toEqual(['X', 'X~1', 'Y']);
  });

  it('keeps the id a list gave to a document when a later tail batch repeats it', () => {
    // Two identical documents in the same millisecond. The list read the first one alone.
    const listed = labelOccurrences([row('X')]);
    // The tail reads from that millisecond again and gets both, in descending server order.
    const tailed = labelOccurrences([row('X'), row('X')]);
    const listedId = listed[0]?.id;
    expect(tailed.map((entry) => entry.id)).toContain(listedId);
    expect(new Set(tailed.map((entry) => entry.id)).size).toBe(2);
    expect(tailed.map((entry) => entry.id)).toEqual(['X', 'X~1']);
  });

  it('does not mix repeats across different milliseconds', () => {
    const labelled = labelOccurrences([
      row('X', '2026-10-09T10:00:00.000Z'),
      row('X', '2026-10-09T10:00:00.001Z'),
    ]);
    expect(labelled.map((entry) => entry.id)).toEqual(['X', 'X']);
  });

  it('returns the batch in ascending timestamp order', () => {
    const labelled = labelOccurrences([
      row('late', '2026-10-09T10:00:02.000Z'),
      row('early', '2026-10-09T10:00:01.000Z'),
    ]);
    expect(labelled.map((entry) => entry.id)).toEqual(['early', 'late']);
  });
});
