import type { z } from 'zod';
import type { MonitorConfigSchema, MonitorSampleSchema, RunningOperationSchema } from './schemas';

export type MonitorSample = z.infer<typeof MonitorSampleSchema>;
export type MonitorConfig = z.infer<typeof MonitorConfigSchema>;
export type RunningOperation = z.infer<typeof RunningOperationSchema>;

// Raw server replies as the adapter received them. Core narrows them with unknown-based helpers.
export interface RawServerSnapshot {
  readonly at: number;
  readonly serverStatus: unknown;
  readonly replSetStatus?: unknown;
}
