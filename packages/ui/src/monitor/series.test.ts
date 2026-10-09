import { findPanel, type MonitorSample, type PanelSpec } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import {
  headlineOf,
  latestSeriesValue,
  mergeSamples,
  panelLines,
  rangeSamples,
  timelineOf,
} from './series';

function sampleAt(
  second: number,
  series: Record<string, number> = {},
  overrides: Partial<MonitorSample> = {},
): MonitorSample {
  return {
    at: new Date(Date.UTC(2026, 9, 9, 10, 0, second)).toISOString(),
    uptimeSeconds: 100 + second,
    opcounters: { insert: 1, query: 10, update: 2, delete: 0, getmore: 3, command: 4 },
    connections: { current: 5, available: 800 },
    network: { bytesInPerSec: 1000, bytesOutPerSec: 2000, requestsPerSec: 20 },
    memory: { residentMb: 500, virtualMb: 1500 },
    series,
    ...overrides,
  };
}

function panel(id: string): PanelSpec {
  const found = findPanel(id);
  if (found === undefined) {
    throw new Error(`missing panel ${id}`);
  }
  return found;
}

function lineValues(samples: MonitorSample[], id: string, seconds?: number): (number | null)[] {
  const line = panelLines(
    timelineOf(samples, seconds === undefined ? 1000 : seconds * 1000),
    panel(id),
  )[0];
  return [...(line?.values ?? [])];
}

const RETENTION_MS = 60_000;

describe('mergeSamples', () => {
  it('sorts by time and drops duplicates', () => {
    const merged = mergeSamples(
      [sampleAt(10), sampleAt(0)],
      [sampleAt(10), sampleAt(5), sampleAt(50)],
      RETENTION_MS,
    );
    expect(merged.map((item) => item.at)).toEqual(
      [sampleAt(0), sampleAt(5), sampleAt(10), sampleAt(50)].map((item) => item.at),
    );
  });

  it('keeps only the samples within the retention window of the newest', () => {
    // The cutoff is 60 s before the newest sample at 120 s, so the samples at 0 s and 30 s go.
    const merged = mergeSamples([sampleAt(0), sampleAt(30)], [sampleAt(120)], RETENTION_MS);
    expect(merged.map((item) => item.at)).toEqual([sampleAt(120).at]);
  });

  it('appends newer samples without re-sorting the history', () => {
    const merged = mergeSamples(
      [sampleAt(0), sampleAt(1)],
      [sampleAt(2), sampleAt(3)],
      RETENTION_MS,
    );
    expect(merged.map((item) => item.at)).toEqual(
      [0, 1, 2, 3].map((second) => sampleAt(second).at),
    );
  });
});

describe('rangeSamples', () => {
  it('measures the range back from the newest sample, not from the clock', () => {
    // The 5 min range reaches back 300 s from the newest sample at 400 s, so the sample at 0 s is out.
    const samples = [sampleAt(0), sampleAt(200), sampleAt(400)];
    expect(rangeSamples(samples, '5m').map((item) => item.at)).toEqual([
      sampleAt(200).at,
      sampleAt(400).at,
    ]);
    expect(rangeSamples([sampleAt(0), sampleAt(400)], '5m').map((item) => item.at)).toEqual([
      sampleAt(400).at,
    ]);
  });

  it('returns nothing when there are no samples', () => {
    expect(rangeSamples([], '5m')).toEqual([]);
  });
});

describe('panelLines', () => {
  it('draws one line per series the panel lists, with the catalogue label and unit', () => {
    const samples = [
      sampleAt(0, { 'op-insert': 1, 'op-query': 2 }),
      sampleAt(1, { 'op-insert': 3, 'op-query': 4 }),
    ];
    const lines = panelLines(timelineOf(samples, 1000), panel('operations-by-type'));
    expect(lines.map((line) => line.label)).toEqual(['Insert', 'Query']);
    expect(lines[0]?.unit).toBe('per-second');
    expect(lines[1]?.values).toEqual([2, 4]);
  });

  it('leaves out a series the window never reports, so no empty legend entry shows', () => {
    const samples = [sampleAt(0, { 'op-insert': 1 })];
    const lines = panelLines(timelineOf(samples, 1000), panel('operations-by-type'));
    expect(lines.map((line) => line.key)).toEqual(['op-insert']);
  });

  it('returns no lines for an empty window', () => {
    expect(panelLines(timelineOf([], 1000), panel('operations-by-type'))).toEqual([]);
  });

  it('gives one lag line per member and folds members past the cap into Other', () => {
    const members = Array.from({ length: 10 }, (_, index) => `db-${index}:27017`);
    const series = Object.fromEntries(members.map((name, index) => [`repl-lag@${name}`, index]));
    const lines = panelLines(timelineOf([sampleAt(0, series)], 1000), panel('replication-lag'));
    expect(lines).toHaveLength(8);
    expect(lines.at(-1)?.label).toBe('Other');
    // The folded members are db-7 to db-9, and Other takes the largest of them.
    expect(lines.at(-1)?.values).toEqual([9]);
    expect(lines[0]?.label).toBe('db-0:27017');
  });

  it('gives no lag lines without replication', () => {
    expect(panelLines(timelineOf([sampleAt(0)], 1000), panel('replication-lag'))).toEqual([]);
  });
});

describe('gaps', () => {
  it('inserts a null break point for a gap longer than 2.5 intervals', () => {
    const samples = [sampleAt(0, { 'op-insert': 1 }), sampleAt(10, { 'op-insert': 2 })];
    const timeline = timelineOf(samples, 1000);
    expect(timeline.points).toHaveLength(3);
    expect(lineValues(samples, 'operations-by-type')).toEqual([1, null, 2]);
  });

  it('does not break a gap that is only two intervals long', () => {
    const samples = [sampleAt(0, { 'op-insert': 1 }), sampleAt(2, { 'op-insert': 2 })];
    expect(lineValues(samples, 'operations-by-type')).toEqual([1, 2]);
  });

  it('does not break history recorded at 10 s after the interval drops to 1 s', () => {
    const samples = [0, 10, 20, 30].map((second) => sampleAt(second, { 'op-insert': second }));
    expect(lineValues(samples, 'operations-by-type', 1)).toEqual([0, 10, 20, 30]);
  });
});

describe('latestSeriesValue', () => {
  it('reads the stat value from the newest sample only', () => {
    const samples = [sampleAt(0, { 'sessions-active': 4 }), sampleAt(1)];
    const spec = panel('logical-sessions').series[0];
    expect(spec).toBeDefined();
    if (spec !== undefined) {
      expect(latestSeriesValue(samples, spec)).toBeUndefined();
      expect(latestSeriesValue([sampleAt(0, { 'sessions-active': 4 })], spec)).toBe(4);
    }
  });
});

describe('headlineOf', () => {
  it('sums the opcounters into operations per second', () => {
    expect(headlineOf(sampleAt(0)).opsPerSecond).toBe(20);
  });

  it('computes cache fill as a percentage of the configured maximum', () => {
    const sample = sampleAt(
      0,
      {},
      {
        wiredTiger: {
          cacheUsedMb: 512,
          cacheMaxMb: 1024,
          cacheDirtyMb: 1,
          readIntoCachePerSec: 0,
          writtenFromCachePerSec: 0,
        },
      },
    );
    expect(headlineOf(sample).cacheFillPercent).toBe(50);
  });

  it('reports undefined for sections the server did not send', () => {
    const headline = headlineOf(undefined);
    expect(headline.uptimeSeconds).toBeUndefined();
    expect(headline.cacheFillPercent).toBeUndefined();
    expect(headlineOf(sampleAt(0)).oplogWindowSeconds).toBeUndefined();
  });
});
