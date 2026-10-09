import type { z } from 'zod';
import type {
  ClusterTopologySchema,
  ConnectionProfileInputSchema,
  ConnectionProfileSchema,
  ConnectionProfileSummarySchema,
  ConnectionStatusSchema,
  ConnectionTestResultSchema,
} from '../schemas/connection';

export type ClusterTopology = z.infer<typeof ClusterTopologySchema>;
export type ConnectionProfile = z.infer<typeof ConnectionProfileSchema>;
export type ConnectionProfileInput = z.infer<typeof ConnectionProfileInputSchema>;
export type ConnectionProfileSummary = z.infer<typeof ConnectionProfileSummarySchema>;
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>;
