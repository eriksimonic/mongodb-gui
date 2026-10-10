import {
  compileSpec,
  DEFAULT_GENERATE_BATCH_SIZE,
  GenerateStartInputSchema,
  type GenerateField,
  type GeneratorSpec,
  type GeneratorType,
} from '@mongo-gui/core';

/** A field row as the dialog holds it. Number inputs can hold text while the user types. */
export interface FieldDraft {
  readonly id: string;
  readonly name: string;
  readonly generator: GeneratorSpec;
  readonly unique: boolean;
}

export const GENERATOR_LABELS: Readonly<Record<GeneratorType, string>> = {
  objectId: 'ObjectId',
  guid: 'GUID (UUID v4)',
  integer: 'Integer',
  decimal: 'Decimal (double)',
  boolean: 'Boolean',
  dateTime: 'Date and time',
  path: 'File path',
  firstName: 'First name',
  lastName: 'Last name',
  fullName: 'Full name',
  email: 'Email',
  word: 'Lorem word',
  sentence: 'Lorem sentence',
  paragraph: 'Lorem paragraph',
  pick: 'Pick from a list',
  sequence: 'Sequence',
};

/** The generator a field starts with after its type is chosen. */
export function defaultGenerator(type: GeneratorType): GeneratorSpec {
  switch (type) {
    case 'objectId':
      return { type };
    case 'guid':
      return { type };
    case 'integer':
      return { type, min: 0, max: 100 };
    case 'decimal':
      return { type, min: 0, max: 100, precision: 2 };
    case 'boolean':
      return { type, trueProbability: 0.5 };
    case 'dateTime':
      return { type, from: '2020-01-01T00:00:00.000Z', to: '2026-12-31T23:59:59.000Z' };
    case 'path':
      return { type, depth: 3, extensions: ['csv'] };
    case 'firstName':
      return { type };
    case 'lastName':
      return { type };
    case 'fullName':
      return { type };
    case 'email':
      return { type, domains: ['example.com'] };
    case 'word':
      return { type };
    case 'sentence':
      return { type };
    case 'paragraph':
      return { type };
    case 'pick':
      return { type, values: ['red', 'green', 'blue'] };
    case 'sequence':
      return { type, start: 1, step: 1 };
    default: {
      const unreachable: never = type;
      throw new Error(`Unknown generator ${unreachable}`);
    }
  }
}

let fieldCounter = 0;

/** A new field row. The id only keys the React list, so a counter is enough. */
export function newFieldDraft(name: string, type: GeneratorType, unique = false): FieldDraft {
  fieldCounter += 1;
  return { id: `field-${fieldCounter}`, name, generator: defaultGenerator(type), unique };
}

/** The fields a new job starts with: an id, a derived email and a few typed values. */
export function starterFields(): FieldDraft[] {
  return [
    newFieldDraft('_id', 'objectId', true),
    newFieldDraft('first', 'firstName'),
    newFieldDraft('last', 'lastName'),
    newFieldDraft('email', 'email'),
    newFieldDraft('createdAt', 'dateTime'),
    newFieldDraft('active', 'boolean'),
  ];
}

/** The reason the job cannot start, or the job input in the shape the router takes. */
export type DraftResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

function fieldsOf(fields: readonly FieldDraft[]): GenerateField[] {
  return fields.map((field) => ({
    name: field.name,
    generator: field.generator,
    unique: field.unique,
  }));
}

export interface DraftJob {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
  readonly count: number | string;
  readonly seed: number | string;
  readonly fields: readonly FieldDraft[];
}

/** Turns the dialog draft into the job input. The first problem is the message the user sees. */
export function jobInputResult(draft: DraftJob) {
  const parsed = GenerateStartInputSchema.safeParse({
    connectionId: draft.connectionId,
    database: draft.database,
    collection: draft.collection,
    count: draft.count,
    seed: draft.seed,
    fields: fieldsOf(draft.fields),
    batchSize: DEFAULT_GENERATE_BATCH_SIZE,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0] === 'fields' ? 'Fields: ' : '';
    return { ok: false as const, message: `${field}${issue?.message ?? 'The job is not valid.'}` };
  }
  return { ok: true as const, value: parsed.data };
}

/** Generates documents from the draft in the renderer, for the preview. Nothing is written. */
export function previewDocuments(
  fields: readonly GenerateField[],
  seed: number,
  count = 3,
): string[] {
  const factory = compileSpec(fields, { seed });
  return Array.from({ length: count }, () => JSON.stringify(factory(), null, 2));
}
