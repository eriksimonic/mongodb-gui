import { z } from 'zod';
import { ToolsVersionSchema } from '../tools/types';

export const FindingSeveritySchema = z.enum(['block', 'strong', 'warning', 'info']);
export const FindingCodeSchema = z.enum([
  'server-too-old',
  'server-version-mismatch',
  'oplog-timeseries-boundary',
  'tools-version-mismatch',
  'tools-patch-differs',
  'tools-version-unknown',
  'timeseries-old-tools',
  'encrypted-collections',
  'sharded-unsupported-option',
  'tools-too-old-for-server',
  'target-newer',
  'target-older-fcv-match',
  'admin-drop',
  'no-sidecar',
  'sidecar-newer-format',
  'sharded-dump',
  'tools-not-installed',
]);
export const FindingActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('use-tools'), version: ToolsVersionSchema }),
  z.object({ kind: z.literal('download-tools'), version: ToolsVersionSchema }),
]);
export const FindingSchema = z.object({
  code: FindingCodeSchema,
  severity: FindingSeveritySchema,
  // Only meaningful for 'block'.
  confirmable: z.boolean(),
  message: z.string(),
  detail: z.string().optional(),
  action: FindingActionSchema.optional(),
});

export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;
export type FindingCode = z.infer<typeof FindingCodeSchema>;
export type FindingAction = z.infer<typeof FindingActionSchema>;
export type Finding = z.infer<typeof FindingSchema>;
