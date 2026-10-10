import { z } from 'zod';
import { AppErrorSchema } from './errors';
import { DockerContainerIdSchema } from '../docker/types';

export const ClusterTopologySchema = z.enum([
  'standalone',
  'replicaSet',
  'sharded',
  'loadBalanced',
  'unknown',
]);

const TlsOptionsSchema = z.object({
  enabled: z.boolean(),
  caFile: z.string().optional(),
  certFile: z.string().optional(),
  allowInvalidCertificates: z.boolean().optional(),
});

export const ConnectionProfileSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  color: z.string().optional(),
  uri: z.string().regex(/^mongodb(\+srv)?:\/\/.+/i),
  tls: TlsOptionsSchema.optional(),
  readPreference: z
    .enum(['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'])
    .optional(),
  connectTimeoutMs: z.number().int().positive().optional(),
  /** `docker` profiles come from a Docker container and are reused for that container. */
  source: z.enum(['manual', 'docker']).optional(),
  dockerContainerId: DockerContainerIdSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const ConnectionProfileInputSchema = ConnectionProfileSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const ConnectionProfileSummarySchema = ConnectionProfileSchema.omit({ uri: true }).extend({
  uriRedacted: z.string(),
});

export const ConnectionStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('disconnected') }),
  z.object({ state: z.literal('connecting') }),
  z.object({
    state: z.literal('connected'),
    serverVersion: z.string(),
    topology: ClusterTopologySchema,
    setName: z.string().optional(),
    hosts: z.array(z.string()),
    /** True when the client talks to one host only, with `directConnection=true` in the URI. */
    directConnection: z.boolean().optional(),
  }),
  z.object({ state: z.literal('error'), error: AppErrorSchema }),
]);

export const ConnectionTestResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    serverVersion: z.string(),
    topology: ClusterTopologySchema,
  }),
  z.object({ ok: z.literal(false), error: AppErrorSchema }),
]);
