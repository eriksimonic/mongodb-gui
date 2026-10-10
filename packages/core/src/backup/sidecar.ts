import { z } from 'zod';
import { DatabaseNameSchema } from '../management/types';
import { ClusterTopologySchema } from '../schemas/connection';
import { Sha256Schema, ToolsVersionSchema } from '../tools/types';
import { BackupScopeSchema, DumpOptionsSchema, ReadPreferenceModeSchema } from './options';

export const SIDECAR_FORMAT = 'mongo-gui.backup';
export const SIDECAR_VERSION = 1;

export const BackupSidecarSchema = z
  .object({
    format: z.literal(SIDECAR_FORMAT),
    formatVersion: z.literal(SIDECAR_VERSION),
    app: z.object({ name: z.literal('Mongo GUI'), version: z.string().max(64) }),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    durationMs: z.number().int().min(0),
    tools: z.object({
      version: ToolsVersionSchema,
      gitVersion: z.string().max(64).optional(),
      goVersion: z.string().max(32).optional(),
      os: z.string().max(32),
      arch: z.string().max(32),
      // ubuntu2004, windows, macos.
      target: z.string().max(64).optional(),
      source: z.enum(['bundled', 'downloaded']),
      mongodumpSha256: Sha256Schema,
    }),
    source: z.object({
      connectionName: z.string().max(200),
      // uriWithoutCredentials: no user info, allow-listed options only.
      uri: z.string().max(4096),
      // host:port, or the SRV name.
      hosts: z.array(z.string().max(300)).max(100),
      srv: z.boolean(),
      docker: z
        .object({
          containerName: z.string().max(255).optional(),
          image: z.string().max(255).optional(),
        })
        .optional(),
      topology: ClusterTopologySchema,
      setName: z.string().max(255).optional(),
      directConnection: z.boolean(),
      serverVersion: z.string().max(64),
      fcv: z.string().max(16).optional(),
      storageEngine: z.string().max(64).optional(),
    }),
    scope: BackupScopeSchema,
    // After defaults, exactly what was used.
    options: DumpOptionsSchema,
    readPreferenceUsed: ReadPreferenceModeSchema,
    // argv without --config. A several-database dump records the argv of the first database.
    // Room for one entry per excluded collection (1000) and prefix (100) plus the fixed flags.
    args: z.array(z.string().max(70_000)).max(1500),
    output: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('archive'),
        fileName: z.string().max(255),
        gzip: z.boolean(),
        bytes: z.number().int().min(0),
        sha256: Sha256Schema,
      }),
      z.object({
        kind: z.literal('directory'),
        dirName: z.string().max(255),
        gzip: z.boolean(),
        bytes: z.number().int().min(0),
        files: z
          .array(
            z.object({
              path: z.string().max(1024),
              bytes: z.number().int().min(0),
              sha256: Sha256Schema,
            }),
          )
          .max(100_000),
      }),
    ]),
    databases: z.array(
      z.object({
        name: DatabaseNameSchema,
        collections: z.array(
          z.object({
            name: z.string().max(255),
            type: z.enum(['collection', 'view', 'timeseries']),
            // From "done dumping" lines. 0 for views.
            documents: z.number().int().min(0),
            estimatedDocuments: z.number().int().min(0).optional(),
            capped: z.boolean().optional(),
            clustered: z.boolean().optional(),
            encrypted: z.boolean().optional(),
          }),
        ),
      }),
    ),
    totals: z.object({
      databases: z.number().int(),
      collections: z.number().int(),
      documents: z.number().int(),
    }),
    oplog: z.boolean(),
    usersAndRoles: z.boolean(),
    // Tool WARNING lines and backup findings.
    warnings: z.array(z.string().max(2000)).max(200),
  })
  .strict();
export const SidecarHeaderSchema = z.object({
  format: z.literal(SIDECAR_FORMAT),
  formatVersion: z.number().int(),
});

export type BackupSidecar = z.infer<typeof BackupSidecarSchema>;
export type SidecarHeader = z.infer<typeof SidecarHeaderSchema>;

export type ParsedSidecar = { sidecar: BackupSidecar } | { problem: string };

// Reads an unknown JSON value. A newer format version is reported before the full parse, so a
// future file is not blamed on a missing field.
export function parseSidecar(value: unknown): ParsedSidecar {
  const header = SidecarHeaderSchema.safeParse(value);
  if (!header.success) return { problem: 'Not a Mongo GUI backup description' };
  if (header.data.formatVersion > SIDECAR_VERSION) return { problem: 'Made by a newer Mongo GUI' };
  const parsed = BackupSidecarSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') || 'file';
    return {
      problem: `The backup description is invalid at ${where}: ${issue?.message ?? ''}`.trim(),
    };
  }
  return { sidecar: parsed.data };
}
