import { z } from 'zod';
import { AbsolutePathSchema } from '../transfer/types';
import { BackupNamespaceInfoSchema } from './server-info';
import { BackupSidecarSchema } from './sidecar';

export const InspectBackupInputSchema = z.object({ path: AbsolutePathSchema });
export const BackupInspectionSchema = z.object({
  // Archive file or dump root folder.
  path: AbsolutePathSchema,
  kind: z.enum(['archive', 'directory']),
  // Directory only. 'database' means the user picked a db folder.
  layout: z.enum(['root', 'database']).optional(),
  gzip: z.boolean(),
  bytes: z.number().int().min(0),
  sidecar: BackupSidecarSchema.optional(),
  sidecarProblem: z.string().max(2000).optional(),
  prelude: z
    .object({
      serverVersion: z.string().max(64).optional(),
      toolsVersion: z.string().max(64).optional(),
    })
    .optional(),
  namespaces: z.array(BackupNamespaceInfoSchema).max(5000),
  hasOplog: z.boolean(),
  hasUsersAndRoles: z.boolean(),
});

export type InspectBackupInput = z.infer<typeof InspectBackupInputSchema>;
export type BackupInspection = z.infer<typeof BackupInspectionSchema>;
