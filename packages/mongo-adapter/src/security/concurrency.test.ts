import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency';

describe('mapWithConcurrency', () => {
  it('keeps the input order and never runs more than the limit at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 30 }, (_, index) => index);
    const doubled = await mapWithConcurrency(items, 8, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return item * 2;
    });
    expect(doubled).toEqual(items.map((item) => item * 2));
    expect(peak).toBe(8);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 8, async () => 1)).toEqual([]);
  });
});
