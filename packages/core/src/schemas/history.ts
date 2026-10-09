import { z } from 'zod';
import { AppErrorSchema } from './errors';

export const HistoryEntrySchema = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  database: z.string(),
  code: z.string(),
  startedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  resultCount: z.number().int().nonnegative().optional(),
  error: AppErrorSchema.optional(),
});

/** A history row before the store assigns its id. */
export const HistoryAppendInputSchema = HistoryEntrySchema.omit({ id: true });

export const FavouriteSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  folder: z.string().optional(),
  code: z.string(),
  connectionId: z.uuid().optional(),
  database: z.string().optional(),
  createdAt: z.iso.datetime(),
});

export const FavouriteInputSchema = FavouriteSchema.omit({ id: true, createdAt: true });
