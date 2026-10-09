import type { MonitorSample } from '@mongo-gui/core';
import type { MetricUnit } from './format';

export const MONITOR_RANGES = ['5m', '15m', '1h'] as const;
export type MonitorRange = (typeof MONITOR_RANGES)[number];

const MS_PER_MINUTE = 60_000;

export const RANGE_MS: Readonly<Record<MonitorRange, number>> = {
  '5m': 5 * MS_PER_MINUTE,
  '15m': 15 * MS_PER_MINUTE,
  '1h': 60 * MS_PER_MINUTE,
};

export const RANGE_LABELS: Readonly<Record<MonitorRange, string>> = {
  '5m': '5 min',
  '15m': '15 min',
  '1h': '1 h',
};

type OpCode = keyof MonitorSample['opcounters'];

const OP_CODES: readonly (readonly [OpCode, string])[] = [
  ['insert', 'Insert'],
  ['query', 'Query'],
  ['update', 'Update'],
  ['delete', 'Delete'],
  ['getmore', 'Get more'],
  ['command', 'Command'],
];

/** One line in a chart. `values` holds null where the server reported nothing. */
export interface SeriesLine {
  readonly key: string;
  readonly label: string;
  readonly unit: MetricUnit;
  readonly values: readonly (number | null)[];
}

/** Every chart on the dashboard, built from one run of samples on a shared time axis. */
export interface MonitorSeries {
  /** Epoch seconds, one per sample, oldest first. */
  readonly times: readonly number[];
  readonly operations: readonly SeriesLine[];
  readonly connections: readonly SeriesLine[];
  readonly network: readonly SeriesLine[];
  readonly memory: readonly SeriesLine[];
  readonly queues: readonly SeriesLine[];
  readonly replicationLag: readonly SeriesLine[];
}

/** The headline numbers for the stat tiles, taken from one sample. */
export interface MonitorHeadline {
  readonly uptimeSeconds: number | undefined;
  readonly currentConnections: number | undefined;
  readonly cacheFillPercent: number | undefined;
  readonly opsPerSecond: number | undefined;
  readonly oplogWindowSeconds: number | undefined;
}

/**
 * Merges incoming samples into a list, drops duplicates by time, sorts oldest first, and keeps
 * only the samples within retentionMs of the newest one.
 */
export function mergeSamples(
  existing: readonly MonitorSample[],
  incoming: readonly MonitorSample[],
  retentionMs: number,
): MonitorSample[] {
  const byTime = new Map<string, MonitorSample>();
  for (const sample of [...existing, ...incoming]) {
    byTime.set(sample.at, sample);
  }
  const sorted = [...byTime.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const newest = sorted.at(-1);
  if (newest === undefined) {
    return [];
  }
  const cutoff = Date.parse(newest.at) - retentionMs;
  return sorted.filter((sample) => Date.parse(sample.at) >= cutoff);
}

/** The samples within a range, measured back from the newest sample rather than the clock. */
export function rangeSamples(
  samples: readonly MonitorSample[],
  range: MonitorRange,
): MonitorSample[] {
  const newest = samples.at(-1);
  if (newest === undefined) {
    return [];
  }
  const cutoff = Date.parse(newest.at) - RANGE_MS[range];
  return samples.filter((sample) => Date.parse(sample.at) >= cutoff);
}

/** Turns samples into the lines of every chart. Charts with no data come back empty. */
export function seriesFromSamples(samples: readonly MonitorSample[]): MonitorSeries {
  const line = (
    key: string,
    label: string,
    unit: MetricUnit,
    pick: (sample: MonitorSample) => number | undefined,
  ): SeriesLine => ({
    key,
    label,
    unit,
    values: samples.map((sample) => pick(sample) ?? null),
  });

  const hasCache = samples.some((sample) => sample.wiredTiger !== undefined);
  const hasLock = samples.some((sample) => sample.globalLock !== undefined);
  const latest = samples.at(-1);
  const members = latest?.replication?.members ?? [];

  return {
    times: samples.map((sample) => Date.parse(sample.at) / 1000),
    operations: OP_CODES.map(([code, label]) =>
      line(`op:${code}`, label, 'perSecond', (sample) => sample.opcounters[code]),
    ),
    connections: [
      line('connections:current', 'Current', 'count', (sample) => sample.connections.current),
      line('connections:available', 'Available', 'count', (sample) => sample.connections.available),
    ],
    network: [
      line('network:in', 'Bytes in', 'bytesPerSecond', (sample) => sample.network.bytesInPerSec),
      line('network:out', 'Bytes out', 'bytesPerSecond', (sample) => sample.network.bytesOutPerSec),
    ],
    memory: [
      line('memory:resident', 'Resident', 'megabytes', (sample) => sample.memory.residentMb),
      line('memory:virtual', 'Virtual', 'megabytes', (sample) => sample.memory.virtualMb),
      ...(hasCache
        ? [
            line(
              'cache:used',
              'Cache used',
              'megabytes',
              (sample) => sample.wiredTiger?.cacheUsedMb,
            ),
            line('cache:max', 'Cache max', 'megabytes', (sample) => sample.wiredTiger?.cacheMaxMb),
          ]
        : []),
    ],
    queues: hasLock
      ? [
          line(
            'queue:readers',
            'Queued readers',
            'count',
            (sample) => sample.globalLock?.currentQueueReaders,
          ),
          line(
            'queue:writers',
            'Queued writers',
            'count',
            (sample) => sample.globalLock?.currentQueueWriters,
          ),
        ]
      : [],
    replicationLag: members.flatMap((member) => {
      const values = samples.map(
        (sample) =>
          sample.replication?.members.find((item) => item.name === member.name)?.lagSeconds ?? null,
      );
      if (values.every((value) => value === null)) {
        return [];
      }
      return [
        {
          key: `lag:${member.name}`,
          label: member.name,
          unit: 'seconds' as const,
          values,
        },
      ];
    }),
  };
}

/** The stat tile values for one sample. Missing sections give undefined, not zero. */
export function headlineOf(sample: MonitorSample | undefined): MonitorHeadline {
  if (sample === undefined) {
    return {
      uptimeSeconds: undefined,
      currentConnections: undefined,
      cacheFillPercent: undefined,
      opsPerSecond: undefined,
      oplogWindowSeconds: undefined,
    };
  }
  const wiredTiger = sample.wiredTiger;
  const cacheFill =
    wiredTiger !== undefined && wiredTiger.cacheMaxMb > 0
      ? (wiredTiger.cacheUsedMb / wiredTiger.cacheMaxMb) * 100
      : undefined;
  const counters = sample.opcounters;
  return {
    uptimeSeconds: sample.uptimeSeconds,
    currentConnections: sample.connections.current,
    cacheFillPercent: cacheFill,
    opsPerSecond:
      counters.insert +
      counters.query +
      counters.update +
      counters.delete +
      counters.getmore +
      counters.command,
    oplogWindowSeconds: sample.replication?.oplogWindowSeconds,
  };
}
