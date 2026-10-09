import type { MonitorSample } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { headlineOf, mergeSamples, rangeSamples, seriesFromSamples } from './series';

function sampleAt(second: number, overrides: Partial<MonitorSample> = {}): MonitorSample {
  return {
    at: new Date(Date.UTC(2026, 9, 9, 10, 0, second)).toISOString(),
    uptimeSeconds: 100 + second,
    opcounters: { insert: 1, query: 10, update: 2, delete: 0, getmore: 3, command: 4 },
    connections: { current: 5, available: 800 },
    network: { bytesInPerSec: 1000, bytesOutPerSec: 2000, requestsPerSec: 20 },
    memory: { residentMb: 500, virtualMb: 1500 },
    ...overrides,
  };
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
    const merged = mergeSamples([sampleAt(0), sampleAt(30)], [sampleAt(90)], RETENTION_MS);
    expect(merged.map((item) => item.at)).toEqual([sampleAt(30).at, sampleAt(90).at]);
  });

  it('returns an empty list for no samples', () => {
    expect(mergeSamples([], [], RETENTION_MS)).toEqual([]);
  });
});

describe('rangeSamples', () => {
  it('measures the range back from the newest sample, not from the clock', () => {
    const samples = [sampleAt(0), sampleAt(60), sampleAt(120), sampleAt(240)];
    expect(rangeSamples(samples, '5m').map((item) => item.at)).toEqual(
      samples.map((item) => item.at),
    );
    expect(rangeSamples(samples, '5m')).toHaveLength(4);
    const tail = rangeSamples([sampleAt(0), sampleAt(200), sampleAt(400)], '5m');
    expect(tail.map((item) => item.at)).toEqual([sampleAt(200).at, sampleAt(400).at]);
  });

  it('returns nothing when there are no samples', () => {
    expect(rangeSamples([], '1h')).toEqual([]);
  });
});

describe('seriesFromSamples', () => {
  it('returns one line per opcode with values in sample order', () => {
    const series = seriesFromSamples([sampleAt(0), sampleAt(1)]);
    expect(series.times).toEqual(
      [sampleAt(0).at, sampleAt(1).at].map((at) => Date.parse(at) / 1000),
    );
    expect(series.operations.map((line) => line.label)).toEqual([
      'Insert',
      'Query',
      'Update',
      'Delete',
      'Get more',
      'Command',
    ]);
    expect(series.operations[1]?.values).toEqual([10, 10]);
    expect(series.operations[1]?.unit).toBe('perSecond');
  });

  it('adds cache lines only when WiredTiger is reported', () => {
    expect(seriesFromSamples([sampleAt(0)]).memory.map((line) => line.key)).toEqual([
      'memory:resident',
      'memory:virtual',
    ]);
    const withCache = sampleAt(1, {
      wiredTiger: {
        cacheUsedMb: 300,
        cacheMaxMb: 1024,
        cacheDirtyMb: 2,
        readIntoCachePerSec: 0,
        writtenFromCachePerSec: 0,
      },
    });
    const memory = seriesFromSamples([sampleAt(0), withCache]).memory;
    expect(memory.map((line) => line.key)).toContain('cache:used');
    expect(memory.find((line) => line.key === 'cache:used')?.values).toEqual([null, 300]);
  });

  it('leaves the queue chart empty when the global lock is not reported', () => {
    expect(seriesFromSamples([sampleAt(0)]).queues).toEqual([]);
  });

  it('builds one lag line per member that reports a lag, and none without replication', () => {
    expect(seriesFromSamples([sampleAt(0)]).replicationLag).toEqual([]);
    const replicated = sampleAt(1, {
      replication: {
        setName: 'rs0',
        members: [
          { name: 'a:27017', state: 'PRIMARY', health: 1, self: true },
          { name: 'b:27017', state: 'SECONDARY', health: 1, lagSeconds: 0.5, self: false },
        ],
      },
    });
    const lag = seriesFromSamples([replicated]).replicationLag;
    expect(lag.map((line) => line.label)).toEqual(['b:27017']);
    expect(lag[0]?.values).toEqual([0.5]);
  });

  it('returns empty lines for no samples', () => {
    const series = seriesFromSamples([]);
    expect(series.times).toEqual([]);
    expect(series.connections[0]?.values).toEqual([]);
  });
});

describe('series breaks and folding', () => {
  it('inserts a null break point for a gap longer than 2.5 intervals', () => {
    const samples = [sampleAt(0), sampleAt(1), sampleAt(10), sampleAt(11)];
    const series = seriesFromSamples(samples, 1000);
    expect(series.times).toHaveLength(5);
    const query = series.operations[1]?.values ?? [];
    expect(query).toEqual([10, 10, null, 10, 10]);
  });

  it('does not break a gap that is only two intervals long', () => {
    const series = seriesFromSamples([sampleAt(0), sampleAt(2)], 1000);
    expect(series.times).toHaveLength(2);
    expect(series.operations[1]?.values).toEqual([10, 10]);
  });

  it('does not break history recorded at 10 s after the interval drops to 1 s', () => {
    const slow = [0, 10, 20, 30].map((second) => sampleAt(second));
    const fast = [31, 32, 33].map((second) => sampleAt(second));
    const series = seriesFromSamples([...slow, ...fast], 1000);
    expect(series.times).toHaveLength(7);
    expect(series.operations[1]?.values.includes(null)).toBe(false);
  });

  it('keeps 10 s history in the disconnected view, which uses the 2 s default', () => {
    const slow = [0, 10, 20, 30, 40, 50].map((second) => sampleAt(second));
    const series = seriesFromSamples(slow, 2000);
    expect(series.times).toHaveLength(6);
    expect(series.operations[1]?.values.includes(null)).toBe(false);
  });

  it('still breaks the line at a real outage between fast samples', () => {
    const before = [0, 1, 2].map((second) => sampleAt(second));
    const after = [62, 63, 64].map((second) => sampleAt(second));
    const series = seriesFromSamples([...before, ...after], 1000);
    expect(series.times).toHaveLength(7);
    expect(series.operations[1]?.values[3]).toBeNull();
  });

  it('plots current connections and keeps available as a readout', () => {
    const sample = sampleAt(0, { connections: { current: 40, available: 800_000, active: 12 } });
    const series = seriesFromSamples([sample]);
    expect(series.connections.map((line) => line.label)).toEqual(['Current', 'Active']);
    expect(series.connectionsReadout.map((line) => line.label)).toEqual(['Available']);
    expect(series.connectionsReadout[0]?.values).toEqual([800_000]);
  });

  it('marks the cache max line as a reference', () => {
    const withCache = sampleAt(0, {
      wiredTiger: {
        cacheUsedMb: 300,
        cacheMaxMb: 1024,
        cacheDirtyMb: 2,
        readIntoCachePerSec: 0,
        writtenFromCachePerSec: 0,
      },
    });
    const cacheMax = seriesFromSamples([withCache]).memory.find((line) => line.key === 'cache:max');
    expect(cacheMax?.reference).toBe(true);
  });

  it('keeps at most eight lag lines and folds the rest into Other', () => {
    const members = Array.from({ length: 10 }, (_, index) => ({
      name: `node-${index}:27017`,
      state: 'SECONDARY',
      health: 1,
      lagSeconds: index,
      self: false,
    }));
    const lagged = sampleAt(0, { replication: { setName: 'rs0', members } });
    const labels = seriesFromSamples([lagged]).replicationLag.map((line) => line.label);
    expect(labels).toHaveLength(8);
    expect(labels.at(-1)).toBe('Other');
    expect(labels).toContain('node-0:27017');
    expect(labels).not.toContain('node-9:27017');
    const other = seriesFromSamples([lagged]).replicationLag.at(-1);
    expect(other?.values).toEqual([9]);
  });
});

describe('mergeSamples append path', () => {
  it('appends newer samples without re-sorting the history', () => {
    const existing = [sampleAt(0), sampleAt(1)];
    const merged = mergeSamples(existing, [sampleAt(2), sampleAt(3)], RETENTION_MS);
    expect(merged.map((item) => item.at)).toEqual(
      [sampleAt(0), sampleAt(1), sampleAt(2), sampleAt(3)].map((item) => item.at),
    );
  });
});

describe('headlineOf', () => {
  it('sums the opcounters into operations per second', () => {
    expect(headlineOf(sampleAt(0)).opsPerSecond).toBe(20);
  });

  it('computes cache fill as a percentage of the configured maximum', () => {
    const sample = sampleAt(0, {
      wiredTiger: {
        cacheUsedMb: 256,
        cacheMaxMb: 1024,
        cacheDirtyMb: 0,
        readIntoCachePerSec: 0,
        writtenFromCachePerSec: 0,
      },
    });
    expect(headlineOf(sample).cacheFillPercent).toBe(25);
  });

  it('reports undefined for sections the server did not send', () => {
    const headline = headlineOf(sampleAt(0));
    expect(headline.cacheFillPercent).toBeUndefined();
    expect(headline.oplogWindowSeconds).toBeUndefined();
    expect(headline.currentConnections).toBe(5);
    expect(headlineOf(undefined).uptimeSeconds).toBeUndefined();
  });
});
