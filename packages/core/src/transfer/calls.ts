import { z } from 'zod';
import {
  AbsolutePathSchema,
  ExportRequestSchema,
  ImportPreviewRequestSchema,
  ImportRequestSchema,
  TransferProgressSchema,
} from './types';

export const TransferKindSchema = z.enum(['import', 'export', 'gridfs-upload', 'gridfs-download']);

export const TransferIdSchema = z.uuid();

export const PreviewImportInputSchema = ImportPreviewRequestSchema.extend({
  connectionId: z.uuid(),
});

export const StartImportInputSchema = ImportRequestSchema.extend({
  connectionId: z.uuid(),
});

export const StartExportInputSchema = ExportRequestSchema.extend({
  connectionId: z.uuid(),
});

export const StartTransferOutputSchema = z.object({ transferId: TransferIdSchema });

export const TransferIdInputSchema = z.object({ transferId: TransferIdSchema });

export const TransferSummarySchema = z.object({
  transferId: TransferIdSchema,
  kind: TransferKindSchema,
  database: z.string().min(1),
  collection: z.string().min(1),
  path: AbsolutePathSchema,
  progress: TransferProgressSchema,
});

export const TransferListOutputSchema = z.array(TransferSummarySchema);

export const DialogFilterSchema = z.object({
  name: z.string().min(1).max(100),
  extensions: z
    .array(
      z
        .string()
        .min(1)
        .max(20)
        .regex(/^[A-Za-z0-9]+$/, 'An extension holds letters and digits only'),
    )
    .min(1)
    .max(20),
});

const DialogBaseSchema = z.object({
  title: z.string().min(1).max(200),
  filters: z.array(DialogFilterSchema).max(20),
});

// A directory dialog picks a folder. The main process then ignores the filters.
export const OpenDialogInputSchema = DialogBaseSchema.extend({
  directory: z.boolean().optional(),
});

export const SaveDialogInputSchema = DialogBaseSchema.extend({
  defaultPath: z.string().min(1).max(4096).optional(),
});

// The renderer receives only the absolute path the user chose. A cancelled dialog gives no path.
export const DialogResultSchema = z.object({ path: AbsolutePathSchema.optional() });

export const ShowItemInFolderInputSchema = z.object({ path: AbsolutePathSchema });

export type PreviewImportInput = z.infer<typeof PreviewImportInputSchema>;
export type StartImportInput = z.infer<typeof StartImportInputSchema>;
export type StartExportInput = z.infer<typeof StartExportInputSchema>;
export type TransferKind = z.infer<typeof TransferKindSchema>;
export type TransferSummary = z.infer<typeof TransferSummarySchema>;
export type DialogFilter = z.infer<typeof DialogFilterSchema>;
export type OpenDialogInput = z.infer<typeof OpenDialogInputSchema>;
export type SaveDialogInput = z.infer<typeof SaveDialogInputSchema>;
export type DialogResult = z.infer<typeof DialogResultSchema>;
