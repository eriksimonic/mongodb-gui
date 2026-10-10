import { z } from 'zod';
import { DatabaseNameSchema } from '../management/types';
import { ClusterTopologySchema } from '../schemas/connection';
import { BackupScopeSchema } from './options';

export const BackupNamespaceInfoSchema = z.object({
  database: DatabaseNameSchema,
  collection: z.string().min(1).max(255),
  type: z.enum(['collection', 'view', 'timeseries']),
  // Estimated before a dump, exact in a sidecar.
  documents: z.number().int().min(0).optional(),
  capped: z.boolean().optional(),
  clustered: z.boolean().optional(),
  // options.encryptedFields is present.
  encrypted: z.boolean().optional(),
});
export const DescribeServerInputSchema = z.object({
  connectionId: z.uuid(),
  scope: BackupScopeSchema.optional(),
});
export const BackupServerInfoSchema = z.object({
  serverVersion: z.string().max(64),
  // getParameter may be refused (Atlas shared tiers).
  fcv: z.string().max(16).optional(),
  storageEngine: z.string().max(64).optional(),
  topology: ClusterTopologySchema,
  setName: z.string().max(255).optional(),
  directConnection: z.boolean(),
  // host:port, no credentials.
  hosts: z.array(z.string().max(300)).max(100),
  databases: z.array(DatabaseNameSchema),
  // Only for the given scope.
  namespaces: z.array(BackupNamespaceInfoSchema).max(5000),
  namespacesTruncated: z.boolean(),
});

export type BackupNamespaceInfo = z.infer<typeof BackupNamespaceInfoSchema>;
export type DescribeServerInput = z.infer<typeof DescribeServerInputSchema>;
export type BackupServerInfo = z.infer<typeof BackupServerInfoSchema>;
