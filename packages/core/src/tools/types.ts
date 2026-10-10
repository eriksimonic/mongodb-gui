import { z } from 'zod';
import { AppErrorSchema } from '../schemas/errors';

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const ToolsVersionSchema = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
export const ToolsPreferenceSchema = z.union([z.literal('auto'), ToolsVersionSchema]);
export const ToolsPlatformSchema = z.object({
  os: z.enum(['linux', 'win32', 'darwin']),
  arch: z.enum(['x64', 'arm64']),
});
export const ToolsInstallIdSchema = z
  .string()
  .regex(/^(bundled|downloaded:\d{1,4}\.\d{1,4}\.\d{1,4})$/);
export const ToolsInstallSchema = z.object({
  id: ToolsInstallIdSchema,
  source: z.enum(['bundled', 'downloaded']),
  version: ToolsVersionSchema,
  // Feed target, such as ubuntu2004.
  target: z.string().max(64).optional(),
  gitVersion: z.string().max(64).optional(),
  // Folder shown in settings.
  location: z.string().max(4096),
  sizeBytes: z.number().int().min(0),
  installedAt: z.iso.datetime().optional(),
  health: z.discriminatedUnion('state', [
    z.object({ state: z.literal('ok') }),
    z.object({ state: z.literal('broken'), error: AppErrorSchema }),
  ]),
  // A running job uses it, so it cannot be removed.
  inUse: z.boolean(),
});
export const ToolsListOutputSchema = z.object({
  platform: ToolsPlatformSchema,
  // False on macOS and on Linux arm64.
  bundledSupported: z.boolean(),
  // Newest version first, bundled first on a tie.
  installs: z.array(ToolsInstallSchema),
  preference: ToolsPreferenceSchema,
  // What the preference picks now.
  resolved: ToolsVersionSchema.optional(),
});
export const ToolsAvailableInputSchema = z.object({ refresh: z.boolean().default(false) });
export const ToolsAvailableOutputSchema = z.object({
  fetchedAt: z.iso.datetime(),
  // Newest first. No URL crosses to the renderer.
  versions: z.array(
    z.object({
      version: ToolsVersionSchema,
      target: z.string().max(64),
      sizeBytes: z.number().int().min(0).optional(),
      installed: z.boolean(),
    }),
  ),
});
export const ToolsDownloadInputSchema = z.object({ version: ToolsVersionSchema });
export const ToolsDownloadOutputSchema = z.object({ downloadId: z.uuid() });
export const ToolsDownloadCancelInputSchema = z.object({ downloadId: z.uuid() });
export const ToolsDownloadProgressSchema = z.object({
  phase: z.enum([
    'downloading',
    'verifying',
    'extracting',
    'checking',
    'done',
    'cancelled',
    'error',
  ]),
  transferred: z.number().int().min(0),
  total: z.number().int().min(0).optional(),
  bytesPerSecond: z.number().min(0).optional(),
  error: AppErrorSchema.optional(),
});
export const ToolsIdInputSchema = z.object({ id: ToolsInstallIdSchema });
export const ToolsLicenceOutputSchema = z.object({
  version: ToolsVersionSchema,
  licence: z.string().max(256 * 1024),
  thirdPartyNotices: z.string().max(2 * 1024 * 1024),
});
// Written next to the binaries by the fetch script and by the downloader. Parsed on every scan.
export const ToolsInstallManifestSchema = z.object({
  format: z.literal('mongo-gui.tools'),
  formatVersion: z.literal(1),
  source: z.enum(['bundled', 'downloaded']),
  version: ToolsVersionSchema,
  target: z.string().max(64),
  os: z.enum(['linux', 'win32', 'darwin']),
  arch: z.enum(['x64', 'arm64']),
  archiveUrl: z.url(),
  archiveSha256: Sha256Schema,
  binaries: z.object({ mongodump: Sha256Schema, mongorestore: Sha256Schema }),
  gitVersion: z.string().max(64).optional(),
  goVersion: z.string().max(32).optional(),
  installedAt: z.iso.datetime(),
});

export type ToolsVersion = z.infer<typeof ToolsVersionSchema>;
export type ToolsPreference = z.infer<typeof ToolsPreferenceSchema>;
export type ToolsPlatform = z.infer<typeof ToolsPlatformSchema>;
export type ToolsInstallId = z.infer<typeof ToolsInstallIdSchema>;
export type ToolsInstall = z.infer<typeof ToolsInstallSchema>;
export type ToolsListOutput = z.infer<typeof ToolsListOutputSchema>;
export type ToolsAvailableInput = z.infer<typeof ToolsAvailableInputSchema>;
export type ToolsAvailableOutput = z.infer<typeof ToolsAvailableOutputSchema>;
export type ToolsDownloadInput = z.infer<typeof ToolsDownloadInputSchema>;
export type ToolsDownloadOutput = z.infer<typeof ToolsDownloadOutputSchema>;
export type ToolsDownloadCancelInput = z.infer<typeof ToolsDownloadCancelInputSchema>;
export type ToolsDownloadProgress = z.infer<typeof ToolsDownloadProgressSchema>;
export type ToolsIdInput = z.infer<typeof ToolsIdInputSchema>;
export type ToolsLicenceOutput = z.infer<typeof ToolsLicenceOutputSchema>;
export type ToolsInstallManifest = z.infer<typeof ToolsInstallManifestSchema>;
