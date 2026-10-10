import { z } from 'zod';
import { StartTransferOutputSchema } from '../transfer/calls';
import {
  GridFsBucketSchema,
  GridFsDeleteInputSchema,
  GridFsDownloadInputSchema,
  GridFsDropBucketInputSchema,
  GridFsFileRefSchema,
  GridFsFileSchema,
  GridFsListBucketsInputSchema,
  GridFsListInputSchema,
  GridFsRenameInputSchema,
  GridFsSetMetadataInputSchema,
  GridFsUploadInputSchema,
} from './types';

// Every GridFS call names the connection it runs against, as the management calls do.
const connectionIdField = { connectionId: z.uuid() };

export const GridFsListBucketsCallSchema = GridFsListBucketsInputSchema.extend(connectionIdField);
export const GridFsListFilesCallSchema = GridFsListInputSchema.extend(connectionIdField);
export const GridFsFileRefCallSchema = GridFsFileRefSchema.extend(connectionIdField);
export const GridFsStartUploadCallSchema = GridFsUploadInputSchema.extend(connectionIdField);
export const GridFsStartDownloadCallSchema = GridFsDownloadInputSchema.extend(connectionIdField);
export const GridFsDeleteCallSchema = GridFsDeleteInputSchema.extend(connectionIdField);
export const GridFsRenameCallSchema = GridFsRenameInputSchema.extend(connectionIdField);
export const GridFsDropBucketCallSchema = GridFsDropBucketInputSchema.extend(connectionIdField);
export const GridFsSetMetadataCallSchema = GridFsSetMetadataInputSchema.extend(connectionIdField);

export const GridFsBucketListSchema = z.array(GridFsBucketSchema);
export const GridFsFileListSchema = z.array(GridFsFileSchema);
export const GridFsDeleteOutputSchema = z.object({ deleted: z.number().int().nonnegative() });
export const GridFsStartOutputSchema = StartTransferOutputSchema;

export type GridFsListBucketsCall = z.infer<typeof GridFsListBucketsCallSchema>;
export type GridFsListFilesCall = z.infer<typeof GridFsListFilesCallSchema>;
export type GridFsFileRefCall = z.infer<typeof GridFsFileRefCallSchema>;
export type GridFsStartUploadCall = z.infer<typeof GridFsStartUploadCallSchema>;
export type GridFsStartDownloadCall = z.infer<typeof GridFsStartDownloadCallSchema>;
export type GridFsDeleteCall = z.infer<typeof GridFsDeleteCallSchema>;
export type GridFsRenameCall = z.infer<typeof GridFsRenameCallSchema>;
export type GridFsDropBucketCall = z.infer<typeof GridFsDropBucketCallSchema>;
export type GridFsSetMetadataCall = z.infer<typeof GridFsSetMetadataCallSchema>;
export type GridFsDeleteOutput = z.infer<typeof GridFsDeleteOutputSchema>;
