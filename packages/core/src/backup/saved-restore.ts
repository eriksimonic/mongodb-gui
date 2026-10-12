import { z } from 'zod';
import { AbsolutePathSchema } from '../transfer/types';
import { ToolsVersionSchema } from '../tools/types';
import { RestoreOptionsSchema } from './options';

export const SavedRestoreNameSchema = z.string().trim().min(1).max(100);

/**
 * A restore the user saved to run again. It holds the connection id, never the connection's
 * credentials, and none of the one-off confirmations of a run.
 */
export const SavedRestoreSchema = z.object({
  id: z.uuid(),
  name: SavedRestoreNameSchema,
  connectionId: z.uuid(),
  source: AbsolutePathSchema,
  toolsVersion: ToolsVersionSchema,
  options: RestoreOptionsSchema,
  createdAt: z.iso.datetime(),
});
export const SavedRestoreInputSchema = SavedRestoreSchema.omit({ id: true, createdAt: true });
export const SavedRestoreRenameInputSchema = z.object({
  id: z.uuid(),
  name: SavedRestoreNameSchema,
});

export type SavedRestore = z.infer<typeof SavedRestoreSchema>;
export type SavedRestoreInput = z.infer<typeof SavedRestoreInputSchema>;
