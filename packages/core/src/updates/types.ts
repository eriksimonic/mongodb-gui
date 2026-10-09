import { z } from 'zod';
import { AppErrorSchema } from '../schemas/errors';

export const UpdatePhaseSchema = z.enum([
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'notify-only',
  'error',
  'disabled',
  'dev',
]);

export const UpdateAvailableSchema = z.object({
  version: z.string().min(1),
  releaseDate: z.string().optional(),
  notes: z.string().optional(),
  downloadUrl: z.url(),
});

export const UpdateProgressSchema = z.object({
  percent: z.number().min(0).max(100),
  bytesPerSecond: z.number().nonnegative().optional(),
  transferred: z.number().nonnegative().optional(),
  total: z.number().nonnegative().optional(),
});

export const UpdateStateSchema = z.object({
  phase: UpdatePhaseSchema,
  current: z.string().min(1),
  available: UpdateAvailableSchema.optional(),
  progress: UpdateProgressSchema.optional(),
  error: AppErrorSchema.optional(),
  canInstall: z.boolean(),
  lastCheckedAt: z.iso.datetime().optional(),
});

export type UpdatePhase = z.infer<typeof UpdatePhaseSchema>;
export type UpdateAvailable = z.infer<typeof UpdateAvailableSchema>;
export type UpdateProgress = z.infer<typeof UpdateProgressSchema>;
export type UpdateState = z.infer<typeof UpdateStateSchema>;
