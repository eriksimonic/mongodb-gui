import type { z } from 'zod';
import type {
  CollectionInfoSchema,
  CollectionStatsSchema,
  DatabaseInfoSchema,
  DatabaseStatsSchema,
  IndexInfoSchema,
} from '../schemas/catalog';

export type DatabaseInfo = z.infer<typeof DatabaseInfoSchema>;
export type CollectionInfo = z.infer<typeof CollectionInfoSchema>;
export type CollectionStats = z.infer<typeof CollectionStatsSchema>;
export type DatabaseStats = z.infer<typeof DatabaseStatsSchema>;
export type IndexInfo = z.infer<typeof IndexInfoSchema>;
