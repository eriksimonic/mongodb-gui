import { z } from 'zod';

/** Most documents one schema analysis samples. */
export const MAX_SCHEMA_SAMPLE_SIZE = 5000;
export const DEFAULT_SCHEMA_SAMPLE_SIZE = 1000;
/** Most example values kept per field. */
export const SCHEMA_EXAMPLE_LIMIT = 5;
/** Longest example text kept. Longer text is cut, and the cut text ends with an ellipsis. */
export const SCHEMA_EXAMPLE_MAX_CHARS = 80;
/** Most distinct values tracked per field. Above this, the distinct ratio is a lower bound. */
export const SCHEMA_DISTINCT_CAP = 1000;

export const SchemaSampleStrategySchema = z.enum(['random', 'first', 'last']);
export type SchemaSampleStrategy = z.infer<typeof SchemaSampleStrategySchema>;

export const SchemaSampleSizeSchema = z.number().int().min(1).max(MAX_SCHEMA_SAMPLE_SIZE);

const CountSchema = z.number().int().min(0);

export const NumberRangeSchema = z.object({ min: z.number(), max: z.number() });
export type NumberRange = z.infer<typeof NumberRangeSchema>;

/** Array length statistics. The average is rounded to two decimals. */
export const ArrayLengthsSchema = z.object({
  min: CountSchema,
  max: CountSchema,
  avg: z.number().min(0),
});
export type ArrayLengths = z.infer<typeof ArrayLengthsSchema>;

/** Date bounds as ISO 8601 strings in UTC. */
export const DateRangeSchema = z.object({ min: z.string(), max: z.string() });
export type DateRange = z.infer<typeof DateRangeSchema>;

export const SchemaFieldSchema = z.object({
  /** Dot path. Array elements appear under "path[]". */
  path: z.string(),
  /** BSON type names seen at the path, sorted. */
  types: z.array(z.string()),
  /** Fraction of sampled documents that contain the path. */
  presence: z.number().min(0).max(1),
  /** Values seen per BSON type. Array elements count under their own path. */
  typeCounts: z.record(z.string(), CountSchema).optional(),
  /** Up to five distinct scalar values as canonical EJSON, each at most 80 characters. */
  examples: z.array(z.string()).max(SCHEMA_EXAMPLE_LIMIT).optional(),
  arrayLengths: ArrayLengthsSchema.optional(),
  /** Bounds of Int32, Long, Double and Decimal128 values. */
  numeric: NumberRangeSchema.optional(),
  dateRange: DateRangeSchema.optional(),
  stringLengths: z.object({ min: CountSchema, max: CountSchema }).optional(),
  /** Distinct scalar values over scalar values seen. A lower bound once the distinct cap is hit. */
  uniqueRatio: z.number().min(0).max(1).optional(),
  /** True when the name looks like an identifier and nearly every value is distinct. */
  isIdLike: z.boolean().optional(),
});

export type SchemaField = z.infer<typeof SchemaFieldSchema>;

export const SchemaAnalyseInputSchema = z.object({
  connectionId: z.uuid(),
  database: z.string().min(1),
  collection: z.string().min(1),
  size: SchemaSampleSizeSchema,
  strategy: SchemaSampleStrategySchema,
});

export type SchemaAnalyseInput = z.infer<typeof SchemaAnalyseInputSchema>;

export const SchemaReportSchema = z.object({
  database: z.string().min(1),
  collection: z.string().min(1),
  /** Documents the sample held. */
  sampled: CountSchema,
  /** Estimated documents in the collection, from the server's metadata. */
  total: CountSchema,
  fields: z.array(SchemaFieldSchema),
  /** ISO 8601 time the analysis finished. */
  at: z.iso.datetime(),
});

export type SchemaReport = z.infer<typeof SchemaReportSchema>;
