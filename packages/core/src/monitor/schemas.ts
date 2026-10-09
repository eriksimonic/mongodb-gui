import { z } from 'zod';

export const DEFAULT_MONITOR_RETENTION_MS = 3_600_000;
export const MIN_MONITOR_INTERVAL_MS = 1_000;
export const MAX_MONITOR_INTERVAL_MS = 10_000;
export const DEFAULT_MONITOR_INTERVAL_MS = 2_000;

const nonNegative = z.number().nonnegative();

export const MonitorIntervalMsSchema = z
  .number()
  .int()
  .min(MIN_MONITOR_INTERVAL_MS)
  .max(MAX_MONITOR_INTERVAL_MS);

export const MonitorConfigSchema = z.object({
  intervalMs: MonitorIntervalMsSchema,
  retentionMs: z.number().int().positive().default(DEFAULT_MONITOR_RETENTION_MS),
});

const OpcountersSchema = z.object({
  insert: nonNegative,
  query: nonNegative,
  update: nonNegative,
  delete: nonNegative,
  getmore: nonNegative,
  command: nonNegative,
});

const WiredTigerSampleSchema = z.object({
  cacheUsedMb: nonNegative,
  cacheMaxMb: nonNegative,
  cacheDirtyMb: nonNegative,
  readIntoCachePerSec: nonNegative,
  writtenFromCachePerSec: nonNegative,
});

const GlobalLockSampleSchema = z.object({
  currentQueueReaders: nonNegative,
  currentQueueWriters: nonNegative,
  activeReaders: nonNegative,
  activeWriters: nonNegative,
});

const ReplicaMemberSampleSchema = z.object({
  name: z.string().min(1),
  state: z.string().min(1),
  health: nonNegative,
  lagSeconds: nonNegative.optional(),
  self: z.boolean(),
});

const ReplicationSampleSchema = z.object({
  setName: z.string().min(1),
  members: z.array(ReplicaMemberSampleSchema),
  oplogWindowSeconds: nonNegative.optional(),
});

export const MonitorSampleSchema = z.object({
  at: z.iso.datetime(),
  uptimeSeconds: nonNegative,
  opcounters: OpcountersSchema,
  connections: z.object({
    current: nonNegative,
    available: nonNegative,
    active: nonNegative.optional(),
  }),
  network: z.object({
    bytesInPerSec: nonNegative,
    bytesOutPerSec: nonNegative,
    requestsPerSec: nonNegative,
  }),
  memory: z.object({
    residentMb: nonNegative,
    virtualMb: nonNegative,
  }),
  wiredTiger: WiredTigerSampleSchema.optional(),
  globalLock: GlobalLockSampleSchema.optional(),
  replication: ReplicationSampleSchema.optional(),
  pageFaultsPerSec: nonNegative.optional(),
});

export const RunningOperationSchema = z.object({
  opid: z.union([z.string(), z.number()]),
  active: z.boolean(),
  secsRunning: nonNegative.optional(),
  op: z.string(),
  ns: z.string(),
  client: z.string().optional(),
  appName: z.string().optional(),
  desc: z.string().optional(),
  command: z.unknown().optional(),
  waitingForLock: z.boolean().optional(),
  planSummary: z.string().optional(),
  effectiveUsers: z.array(z.string()).optional(),
});
