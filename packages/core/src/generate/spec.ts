import { z } from 'zod';
import { AppErrorSchema } from '../schemas/errors';
import { CollectionNameSchema, DatabaseNameSchema } from '../management/types';
import { FieldPathSchema } from '../transfer/types';
import { generateProblems } from './generators';

export const DEFAULT_GENERATE_COUNT = 10_000;
export const MAX_GENERATE_COUNT = 10_000_000;
export const MAX_GENERATE_BATCH_SIZE = 10_000;
export const DEFAULT_GENERATE_BATCH_SIZE = 10_000;
export const MAX_GENERATE_FIELDS = 100;
export const MAX_PICK_VALUES = 1000;
const MAX_NAME_LENGTH = 200;
const MAX_DEPTH = 6;
const MAX_EXTENSIONS = 10;
const MAX_DOMAINS = 10;
const MAX_DECIMAL_PRECISION = 10;
const MAX_DECIMAL_MAGNITUDE = 1e12;
const MAX_SEQUENCE_STEP = 1_000_000;
const MAX_SEQUENCE_START = Number.MAX_SAFE_INTEGER;
const SAFE_INTEGER = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);

export const GenerateSeedSchema = z.number().int().min(0).max(0xffff_ffff);

const DateStringSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'A date must be a valid ISO 8601 string',
});

const ExtensionSchema = z
  .string()
  .regex(/^[a-z0-9]{1,10}$/, 'An extension is 1 to 10 lower-case letters or digits');

const DomainSchema = z
  .string()
  .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'A domain is lower-case labels separated by dots');

export const PickValueSchema = z.union([z.string().max(200), z.number().finite(), z.boolean()]);

export const ObjectIdGeneratorSchema = z.object({ type: z.literal('objectId') });
export const GuidGeneratorSchema = z.object({ type: z.literal('guid') });

export const IntegerGeneratorSchema = z
  .object({
    type: z.literal('integer'),
    min: SAFE_INTEGER,
    max: SAFE_INTEGER,
  })
  .refine((value) => value.min <= value.max, {
    message: 'The minimum must not be greater than the maximum',
    path: ['max'],
  });

export const DecimalGeneratorSchema = z
  .object({
    type: z.literal('decimal'),
    min: z.number().finite().min(-MAX_DECIMAL_MAGNITUDE).max(MAX_DECIMAL_MAGNITUDE),
    max: z.number().finite().min(-MAX_DECIMAL_MAGNITUDE).max(MAX_DECIMAL_MAGNITUDE),
    precision: z.number().int().min(0).max(MAX_DECIMAL_PRECISION),
  })
  .refine((value) => value.min <= value.max, {
    message: 'The minimum must not be greater than the maximum',
    path: ['max'],
  });

export const BooleanGeneratorSchema = z.object({
  type: z.literal('boolean'),
  trueProbability: z.number().min(0).max(1),
});

export const DateTimeGeneratorSchema = z
  .object({
    type: z.literal('dateTime'),
    from: DateStringSchema,
    to: DateStringSchema,
  })
  .refine((value) => Date.parse(value.from) <= Date.parse(value.to), {
    message: 'The start must not be after the end',
    path: ['to'],
  });

export const PathGeneratorSchema = z.object({
  type: z.literal('path'),
  depth: z.number().int().min(1).max(MAX_DEPTH),
  extensions: z.array(ExtensionSchema).min(1).max(MAX_EXTENSIONS),
});

export const FirstNameGeneratorSchema = z.object({ type: z.literal('firstName') });
export const LastNameGeneratorSchema = z.object({ type: z.literal('lastName') });
export const FullNameGeneratorSchema = z.object({ type: z.literal('fullName') });

export const EmailGeneratorSchema = z.object({
  type: z.literal('email'),
  domains: z.array(DomainSchema).min(1).max(MAX_DOMAINS),
});

export const WordGeneratorSchema = z.object({ type: z.literal('word') });
export const SentenceGeneratorSchema = z.object({ type: z.literal('sentence') });
export const ParagraphGeneratorSchema = z.object({ type: z.literal('paragraph') });

export const PickGeneratorSchema = z
  .object({
    type: z.literal('pick'),
    values: z.array(PickValueSchema).min(1).max(MAX_PICK_VALUES),
    weights: z.array(z.number().finite().min(0)).optional(),
  })
  .refine((value) => value.weights === undefined || value.weights.length === value.values.length, {
    message: 'There must be one weight for each value',
    path: ['weights'],
  })
  .refine(
    (value) =>
      value.weights === undefined || value.weights.reduce((sum, weight) => sum + weight, 0) > 0,
    { message: 'At least one weight must be above zero', path: ['weights'] },
  );

export const SequenceGeneratorSchema = z.object({
  type: z.literal('sequence'),
  start: SAFE_INTEGER.min(-MAX_SEQUENCE_START).max(MAX_SEQUENCE_START),
  step: z
    .number()
    .int()
    .min(-MAX_SEQUENCE_STEP)
    .max(MAX_SEQUENCE_STEP)
    .refine((value) => value !== 0, { message: 'The step must not be zero' }),
});

export const GeneratorSchema = z.discriminatedUnion('type', [
  ObjectIdGeneratorSchema,
  GuidGeneratorSchema,
  IntegerGeneratorSchema,
  DecimalGeneratorSchema,
  BooleanGeneratorSchema,
  DateTimeGeneratorSchema,
  PathGeneratorSchema,
  FirstNameGeneratorSchema,
  LastNameGeneratorSchema,
  FullNameGeneratorSchema,
  EmailGeneratorSchema,
  WordGeneratorSchema,
  SentenceGeneratorSchema,
  ParagraphGeneratorSchema,
  PickGeneratorSchema,
  SequenceGeneratorSchema,
]);

export const GenerateFieldSchema = z.object({
  name: FieldPathSchema.max(MAX_NAME_LENGTH),
  generator: GeneratorSchema,
  unique: z.boolean().default(false),
});

/** The field names of one job. Two fields may not share a path, and one may not sit under another. */
export const GenerateFieldsSchema = z
  .array(GenerateFieldSchema)
  .min(1)
  .max(MAX_GENERATE_FIELDS)
  .superRefine((fields, ctx) => {
    const problem = fieldNameProblem(fields.map((field) => field.name));
    if (problem !== undefined) {
      ctx.addIssue({ code: 'custom', message: problem });
    }
  });

export const GenerateStartInputSchema = z
  .object({
    connectionId: z.uuid(),
    database: DatabaseNameSchema,
    collection: CollectionNameSchema,
    count: z.number().int().min(1).max(MAX_GENERATE_COUNT).default(DEFAULT_GENERATE_COUNT),
    seed: GenerateSeedSchema,
    fields: GenerateFieldsSchema,
    batchSize: z
      .number()
      .int()
      .min(1)
      .max(MAX_GENERATE_BATCH_SIZE)
      .default(DEFAULT_GENERATE_BATCH_SIZE),
  })
  .superRefine((input, ctx) => {
    // Checked up front, so a configuration that cannot fill its unique fields fails before any write.
    for (const message of generateProblems(input.fields, input.count)) {
      ctx.addIssue({ code: 'custom', message, path: ['fields'] });
    }
  });

export const GenerateStartOutputSchema = z.object({ jobId: z.uuid() });

export const GenerateCancelInputSchema = z.object({ jobId: z.uuid() });

export const GenerateProgressSchema = z.object({
  total: z.number().int().min(0),
  inserted: z.number().int().min(0),
  failed: z.number().int().min(0),
  elapsedMs: z.number().min(0),
  ratePerSecond: z.number().min(0),
  done: z.boolean(),
  cancelled: z.boolean(),
  error: AppErrorSchema.optional(),
});

export type GeneratorSpec = z.infer<typeof GeneratorSchema>;
export type GeneratorType = GeneratorSpec['type'];
export type GenerateField = z.infer<typeof GenerateFieldSchema>;
export type GenerateStartInput = z.infer<typeof GenerateStartInputSchema>;
export type GenerateStartOutput = z.infer<typeof GenerateStartOutputSchema>;
export type GenerateProgress = z.infer<typeof GenerateProgressSchema>;

/**
 * Returns the first problem with a set of dotted field paths, or undefined when they are usable.
 * A duplicate path, or a path that is a prefix of another, cannot be written as one document.
 */
export function fieldNameProblem(names: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      return `The field "${name}" is listed more than once`;
    }
    seen.add(name);
  }
  for (const name of names) {
    const segments = name.split('.');
    for (let length = 1; length < segments.length; length += 1) {
      const prefix = segments.slice(0, length).join('.');
      if (seen.has(prefix)) {
        return `The field "${prefix}" holds a value, so "${name}" cannot be nested under it`;
      }
    }
  }
  return undefined;
}

/** The generator types in the order the UI lists them. Keep it in step with GeneratorSchema. */
export const GENERATOR_TYPES: readonly GeneratorType[] = [
  'objectId',
  'guid',
  'integer',
  'decimal',
  'boolean',
  'dateTime',
  'path',
  'firstName',
  'lastName',
  'fullName',
  'email',
  'word',
  'sentence',
  'paragraph',
  'pick',
  'sequence',
];
