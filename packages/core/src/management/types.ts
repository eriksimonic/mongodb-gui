import { z } from 'zod';

const MAX_COLLECTION_NAME_BYTES = 255;
const MAX_DATABASE_NAME_BYTES = 63;
const DATABASE_FORBIDDEN_CHARS = /[/\\. "$]/;
const SYSTEM_PREFIX = 'system.';
const NULL_BYTE = '\u0000';

// UTF-8 length, counted per code point so the core package needs no DOM or Node types.
function byteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const PositiveIntSchema = z.number().int().positive();

const DatabaseNameSchema = z
  .string()
  .min(1)
  .refine((value) => byteLength(value) <= MAX_DATABASE_NAME_BYTES, {
    message: `Database names are at most ${MAX_DATABASE_NAME_BYTES} bytes`,
  })
  .refine((value) => !DATABASE_FORBIDDEN_CHARS.test(value), {
    message: 'Database names may not contain / \\ . space " or $',
  })
  .refine((value) => !value.includes(NULL_BYTE), { message: 'Names may not contain a null byte' });

const ExistingCollectionNameSchema = z
  .string()
  .min(1)
  .refine((value) => byteLength(value) <= MAX_COLLECTION_NAME_BYTES, {
    message: `Collection names are at most ${MAX_COLLECTION_NAME_BYTES} bytes`,
  })
  .refine((value) => !value.includes('$'), { message: 'Collection names may not contain $' })
  .refine((value) => !value.includes(NULL_BYTE), { message: 'Names may not contain a null byte' });

export const CollectionNameSchema = ExistingCollectionNameSchema.refine(
  (value) => !value.startsWith(SYSTEM_PREFIX),
  { message: 'Collection names may not start with system.' },
);

export const ValidationLevelSchema = z.enum(['off', 'strict', 'moderate']);
export const ValidationActionSchema = z.enum(['error', 'warn']);

export const CreateCollectionInputSchema = z
  .object({
    database: DatabaseNameSchema,
    name: CollectionNameSchema,
    capped: z
      .object({
        sizeBytes: PositiveIntSchema,
        maxDocuments: PositiveIntSchema.optional(),
      })
      .optional(),
    timeseries: z
      .object({
        timeField: z.string().min(1),
        metaField: z.string().min(1).optional(),
        granularity: z.enum(['seconds', 'minutes', 'hours']).optional(),
        expireAfterSeconds: PositiveIntSchema.optional(),
      })
      .optional(),
    clusteredIndex: z.boolean().optional(),
    collation: z.unknown().optional(),
    validator: z.unknown().optional(),
    validationLevel: ValidationLevelSchema.optional(),
    validationAction: ValidationActionSchema.optional(),
  })
  .refine((input) => !(input.capped !== undefined && input.timeseries !== undefined), {
    message: 'A collection cannot be both capped and timeseries',
  });

export const RenameCollectionInputSchema = z
  .object({
    database: DatabaseNameSchema,
    name: ExistingCollectionNameSchema,
    newName: CollectionNameSchema,
    dropTarget: z.boolean().optional(),
  })
  .refine((input) => input.name !== input.newName, {
    message: 'The new name must differ from the current name',
    path: ['newName'],
  });

export const DropCollectionInputSchema = z.object({
  database: DatabaseNameSchema,
  name: ExistingCollectionNameSchema,
});

export const ClearCollectionInputSchema = DropCollectionInputSchema;

export const CreateDatabaseInputSchema = z.object({
  database: DatabaseNameSchema,
  initialCollection: CollectionNameSchema,
});

export const DropDatabaseInputSchema = z.object({
  database: DatabaseNameSchema,
});

export const IndexKeyValueSchema = z.union([
  z.literal(1),
  z.literal(-1),
  z.literal('text'),
  z.literal('2dsphere'),
  z.literal('hashed'),
  z.literal('2d'),
]);

export const CreateIndexInputSchema = z.object({
  database: DatabaseNameSchema,
  collection: ExistingCollectionNameSchema,
  keys: z
    .record(z.string().min(1), IndexKeyValueSchema)
    .refine((keys) => Object.keys(keys).length > 0, { message: 'At least one key is required' }),
  options: z.object({
    name: z.string().min(1).optional(),
    unique: z.boolean().optional(),
    sparse: z.boolean().optional(),
    hidden: z.boolean().optional(),
    expireAfterSeconds: z.number().int().nonnegative().optional(),
    partialFilterExpression: z.unknown().optional(),
    collation: z.unknown().optional(),
    wildcardProjection: z.unknown().optional(),
    background: z.boolean().optional(),
    weights: z.record(z.string().min(1), z.number().positive()).optional(),
    defaultLanguage: z.string().min(1).optional(),
  }),
});

export const DropIndexInputSchema = z.object({
  database: DatabaseNameSchema,
  collection: ExistingCollectionNameSchema,
  name: z.string().min(1),
});

export const SetIndexHiddenInputSchema = DropIndexInputSchema.extend({
  hidden: z.boolean(),
});

export const ValidationRulesSchema = z.object({
  validator: z.unknown(),
  validationLevel: ValidationLevelSchema,
  validationAction: ValidationActionSchema,
});

export const SetValidationInputSchema = z.object({
  database: DatabaseNameSchema,
  collection: ExistingCollectionNameSchema,
  rules: ValidationRulesSchema,
});

export const ValidationCheckResultSchema = z.object({
  ok: z.boolean(),
  errors: z.array(
    z.object({
      path: z.string().optional(),
      message: z.string(),
    }),
  ),
});

export const IndexBuildProgressSchema = z.object({
  collection: z.string(),
  indexName: z.string(),
  phase: z.string(),
  progressPercent: z.number().min(0).max(100).optional(),
  opid: z.union([z.string(), z.number()]),
});

const DocumentTargetSchema = z.object({
  database: DatabaseNameSchema,
  collection: ExistingCollectionNameSchema,
});

export const InsertDocumentInputSchema = DocumentTargetSchema.extend({
  documentEjson: z.string(),
});

export const ReplaceDocumentInputSchema = DocumentTargetSchema.extend({
  idEjson: z.string(),
  documentEjson: z.string(),
});

export const UpdateDocumentFieldsInputSchema = DocumentTargetSchema.extend({
  idEjson: z.string(),
  setEjson: z.string().optional(),
  unsetPaths: z.array(z.string().min(1)).optional(),
}).refine(
  (input) =>
    input.setEjson !== undefined || (input.unsetPaths !== undefined && input.unsetPaths.length > 0),
  { message: 'Give setEjson, unsetPaths, or both' },
);

export const DeleteDocumentsInputSchema = DocumentTargetSchema.extend({
  idsEjson: z.array(z.string()),
});

export const DeleteByFilterInputSchema = DocumentTargetSchema.extend({
  filterEjson: z.string(),
  expectedCount: z.number().int().nonnegative(),
});

export const FindDocumentByIdInputSchema = DocumentTargetSchema.extend({
  idEjson: z.string(),
});

export type CreateCollectionInput = z.infer<typeof CreateCollectionInputSchema>;
export type RenameCollectionInput = z.infer<typeof RenameCollectionInputSchema>;
export type DropCollectionInput = z.infer<typeof DropCollectionInputSchema>;
export type ClearCollectionInput = z.infer<typeof ClearCollectionInputSchema>;
export type CreateDatabaseInput = z.infer<typeof CreateDatabaseInputSchema>;
export type DropDatabaseInput = z.infer<typeof DropDatabaseInputSchema>;
export type IndexKeyValue = z.infer<typeof IndexKeyValueSchema>;
export type CreateIndexInput = z.infer<typeof CreateIndexInputSchema>;
export type DropIndexInput = z.infer<typeof DropIndexInputSchema>;
export type SetIndexHiddenInput = z.infer<typeof SetIndexHiddenInputSchema>;
export type ValidationRules = z.infer<typeof ValidationRulesSchema>;
export type SetValidationInput = z.infer<typeof SetValidationInputSchema>;
export type ValidationCheckResult = z.infer<typeof ValidationCheckResultSchema>;
export type IndexBuildProgress = z.infer<typeof IndexBuildProgressSchema>;
export type InsertDocumentInput = z.infer<typeof InsertDocumentInputSchema>;
export type ReplaceDocumentInput = z.infer<typeof ReplaceDocumentInputSchema>;
export type UpdateDocumentFieldsInput = z.infer<typeof UpdateDocumentFieldsInputSchema>;
export type DeleteDocumentsInput = z.infer<typeof DeleteDocumentsInputSchema>;
export type DeleteByFilterInput = z.infer<typeof DeleteByFilterInputSchema>;
export type FindDocumentByIdInput = z.infer<typeof FindDocumentByIdInputSchema>;
