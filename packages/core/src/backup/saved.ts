import { z } from 'zod';
import { ToolsVersionSchema } from '../tools/types';
import { BackupScopeSchema, DumpOptionsSchema } from './options';

/**
 * A backup configuration kept to run again. It holds no secret: the connection is an id and the
 * credentials stay in the connection profile. The folder is not kept, because a folder is valid
 * only after a dialog pick in the current session. The file name is made anew on each run.
 */
export const SavedBackupSchema = z.object({
  id: z.uuid(),
  label: z.string().trim().min(1).max(200),
  connectionId: z.uuid(),
  scope: BackupScopeSchema,
  options: DumpOptionsSchema,
  toolsVersion: ToolsVersionSchema.optional(),
  createdAt: z.iso.datetime(),
});

export const SavedBackupInputSchema = SavedBackupSchema.omit({ id: true, createdAt: true });
export const SavedBackupRenameInputSchema = SavedBackupSchema.pick({ id: true, label: true });

export type SavedBackup = z.infer<typeof SavedBackupSchema>;
export type SavedBackupInput = z.infer<typeof SavedBackupInputSchema>;
export type SavedBackupRenameInput = z.infer<typeof SavedBackupRenameInputSchema>;
