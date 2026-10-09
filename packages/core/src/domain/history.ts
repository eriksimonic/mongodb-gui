import type { z } from 'zod';
import type { FavouriteInputSchema, FavouriteSchema, HistoryEntrySchema } from '../schemas/history';

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type Favourite = z.infer<typeof FavouriteSchema>;
export type FavouriteInput = z.infer<typeof FavouriteInputSchema>;
