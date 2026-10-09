import { z } from 'zod';
import { isSyntheticOpid } from '../monitor/opid';
import {
  MonitorConfigSchema,
  MonitorIntervalMsSchema,
  MonitorSampleSchema,
  RunningOperationSchema,
} from '../monitor/schemas';

const connectionParam = z.object({ connectionId: z.uuid() });

export const MonitorStartInputSchema = connectionParam.extend({
  intervalMs: MonitorIntervalMsSchema.optional(),
});

export const MonitorStopInputSchema = connectionParam;

export const MonitorSamplesInputSchema = connectionParam.extend({
  sinceIso: z.iso.datetime().optional(),
});

export const MonitorOperationsInputSchema = connectionParam.extend({
  includeIdle: z.boolean().optional(),
  includeSystem: z.boolean().optional(),
});

// Idle connections carry a synthetic "conn:N" id, which killOp cannot take.
export const MonitorKillInputSchema = connectionParam.extend({
  opid: z.union([
    z.number().int().nonnegative(),
    z
      .string()
      .min(1)
      .refine((value) => !isSyntheticOpid(value), 'Idle connections cannot be killed'),
  ]),
});

export const MonitorSetIntervalInputSchema = connectionParam.extend({
  intervalMs: MonitorIntervalMsSchema,
});

export const MonitorSamplesOutputSchema = z.array(MonitorSampleSchema);
export const MonitorOperationsOutputSchema = z.array(RunningOperationSchema);
export const MonitorConfigOutputSchema = MonitorConfigSchema;
