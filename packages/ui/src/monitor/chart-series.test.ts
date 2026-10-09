import { findPanel } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { chartSeries, stackedValues } from './chart-series';
import type { ChartSeries } from './chart-types';
import { seriesColor } from './palette';

function line(key: string, values: (number | null)[]): ChartSeries {
  return { key, label: key, color: '#000000', unit: 'per-second', values };
}

describe('stackedValues', () => {
  it('adds each series to the ones below it', () => {
    const stacked = stackedValues([line('a', [1, 2]), line('b', [10, 20]), line('c', [100, 200])]);
    expect(stacked).toEqual([
      [1, 2],
      [11, 22],
      [111, 222],
    ]);
  });

  it('keeps a gap as a gap in its own line and counts it as zero in the stack above', () => {
    const stacked = stackedValues([line('a', [1, null, 3]), line('b', [10, 20, null])]);
    // Series a has no value at index 1, so b there is its own 20 with nothing below it.
    expect(stacked).toEqual([
      [1, null, 3],
      [11, 20, null],
    ]);
  });

  it('returns no rows for no series', () => {
    expect(stackedValues([])).toEqual([]);
  });
});

describe('chartSeries', () => {
  it('colours a line by its series position in the catalogue, not by its position among the drawn lines', () => {
    const panel = findPanel('operations-by-type');
    const third = panel?.series[2];
    if (panel === undefined || third === undefined) {
      throw new Error('the operations panel has three series');
    }
    const [only] = chartSeries(
      [{ key: third.id, label: third.label, unit: third.unit, values: [1] }],
      panel,
    );
    expect(only?.color).toBe(seriesColor(2));
  });

  it('gives each member lag line the colour of the lag series', () => {
    const panel = findPanel('replication-lag');
    if (panel === undefined) {
      throw new Error('missing replication panel');
    }
    const [member] = chartSeries(
      [{ key: 'repl-lag@node-b', label: 'node-b', unit: 'seconds', values: [1] }],
      panel,
    );
    expect(member?.color).toBe(seriesColor(0));
  });
});
