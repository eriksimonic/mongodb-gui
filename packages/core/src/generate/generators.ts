import { AppErrorException, appError } from '../domain/errors';
import { FIRST_NAMES, LAST_NAMES, LOREM_WORDS } from './names';
import type { GenerateField, GeneratorSpec } from './spec';

/** A document built by the generators. The keys are the top-level fields of the job. */
export type GeneratedDocument = Record<string, unknown>;

/** Produces one field value. The document built so far is passed for generators that read it. */
export type ValueFn = (doc: GeneratedDocument) => unknown;

export interface Prng {
  /** The next 32 random bits as an unsigned integer. */
  nextUint32(): number;
  /** A number from 0 up to, not including, 1. */
  nextFloat(): number;
  /** An integer from min to max, both included. */
  nextInt(min: number, max: number): number;
}

export interface CompileOptions {
  readonly seed: number;
  /** Turns a 24-character hex string into the value stored for objectId. Defaults to the string. */
  readonly toObjectId?: (hex: string) => unknown;
}

/** Draws of a value that is already in the run, before the field gives up on uniqueness. */
const MAX_RESAMPLES = 8;
const PATH_DIRECTORIES: readonly string[] = [
  'var',
  'data',
  'logs',
  'reports',
  'exports',
  'archive',
  'backup',
  'tmp',
  'home',
  'srv',
  'app',
  'share',
  'incoming',
  'outgoing',
  'staging',
  'cache',
  'imports',
  'jobs',
  'metrics',
  'billing',
  '2024',
  '2025',
  '2026',
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '10',
  '11',
  '12',
];
const PATH_STEMS: readonly string[] = [
  'report',
  'invoice',
  'export',
  'backup',
  'trace',
  'event',
  'batch',
  'snapshot',
  'audit',
  'sync',
];
const PATH_FILE_NUMBER_MAX = 999_999;
const HEX: readonly string[] = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(16).padStart(2, '0'),
);
const TWO_POW_32 = 4_294_967_296;

/**
 * mulberry32. The same seed gives the same sequence on every run, so a job can be repeated. The
 * state is one 32-bit integer, so a draw costs a few integer operations and no allocation.
 */
export function createPrng(seed: number): Prng {
  let state = seed >>> 0;
  const nextUint32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
  const nextFloat = (): number => nextUint32() / TWO_POW_32;
  const nextInt = (min: number, max: number): number =>
    min + Math.floor(nextFloat() * (max - min + 1));
  return { nextUint32, nextFloat, nextInt };
}

function choose(prng: Prng, list: readonly string[]): string {
  return list[prng.nextInt(0, list.length - 1)] ?? '';
}

/** A 24-character hex string: twelve random bytes. */
export function objectIdHex(prng: Prng): string {
  let out = '';
  for (let index = 0; index < 12; index += 1) {
    out += HEX[prng.nextUint32() & 0xff];
  }
  return out;
}

/** A version 4 UUID: the version and variant bits are set, the rest is random. */
export function guidString(prng: Prng): string {
  const bytes: number[] = [];
  for (let index = 0; index < 16; index += 1) {
    bytes.push(prng.nextUint32() & 0xff);
  }
  const hex = bytes.map((byte, index) => {
    if (index === 6) {
      return HEX[(byte & 0x0f) | 0x40];
    }
    if (index === 8) {
      return HEX[(byte & 0x3f) | 0x80];
    }
    return HEX[byte];
  });
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

export function integerValue(prng: Prng, min: number, max: number): number {
  return prng.nextInt(min, max);
}

/** A number with `precision` decimal places, kept inside min and max after rounding. */
export function decimalValue(prng: Prng, min: number, max: number, precision: number): number {
  const scale = 10 ** precision;
  const raw = min + prng.nextFloat() * (max - min);
  const rounded = Math.round(raw * scale) / scale;
  return Math.min(max, Math.max(min, rounded));
}

export function booleanValue(prng: Prng, trueProbability: number): boolean {
  return prng.nextFloat() < trueProbability;
}

/** A date from `fromMs` to `toMs`, both included, at millisecond precision. */
export function dateValue(prng: Prng, fromMs: number, toMs: number): Date {
  return new Date(fromMs + prng.nextInt(0, toMs - fromMs));
}

/** A path such as /var/data/2026/10/report-123.csv, with `depth` directories above the file. */
export function pathValue(prng: Prng, depth: number, extensions: readonly string[]): string {
  let out = '';
  for (let index = 0; index < depth; index += 1) {
    out += `/${choose(prng, PATH_DIRECTORIES)}`;
  }
  const stem = choose(prng, PATH_STEMS);
  const number = prng.nextInt(1, PATH_FILE_NUMBER_MAX);
  const extension = extensions[prng.nextInt(0, extensions.length - 1)] ?? 'csv';
  return `${out}/${stem}-${number}.${extension}`;
}

export function firstNameValue(prng: Prng): string {
  return choose(prng, FIRST_NAMES);
}

export function lastNameValue(prng: Prng): string {
  return choose(prng, LAST_NAMES);
}

/**
 * An address on one of the domains. The local part is "first.last" from the given names, or from
 * random names when the caller has none.
 */
export function emailValue(
  prng: Prng,
  domains: readonly string[],
  first: string | undefined,
  last: string | undefined,
): string {
  const localFirst = first ?? firstNameValue(prng);
  const localLast = last ?? lastNameValue(prng);
  const domain = domains[prng.nextInt(0, domains.length - 1)] ?? domains[0] ?? 'example.com';
  return `${localFirst}.${localLast}@${domain}`;
}

export function wordValue(prng: Prng): string {
  return choose(prng, LOREM_WORDS);
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Five to twelve words, capitalised, with a full stop. */
export function sentenceValue(prng: Prng): string {
  const count = prng.nextInt(5, 12);
  const words: string[] = [];
  for (let index = 0; index < count; index += 1) {
    words.push(wordValue(prng));
  }
  const [head = '', ...rest] = words;
  return `${[capitalise(head), ...rest].join(' ')}.`;
}

/** Three to six sentences separated by spaces. */
export function paragraphValue(prng: Prng): string {
  const count = prng.nextInt(3, 6);
  const sentences: string[] = [];
  for (let index = 0; index < count; index += 1) {
    sentences.push(sentenceValue(prng));
  }
  return sentences.join(' ');
}

/** Picks a value from the list. With weights, a value is chosen in proportion to its weight. */
function pickFn(
  prng: Prng,
  values: readonly (string | number | boolean)[],
  weights: readonly number[] | undefined,
): () => string | number | boolean {
  const last = values.length - 1;
  if (weights === undefined) {
    return () => values[prng.nextInt(0, last)] ?? values[0] ?? '';
  }
  const cumulative = new Float64Array(values.length);
  let total = 0;
  weights.forEach((weight, index) => {
    total += weight;
    cumulative[index] = total;
  });
  return () => {
    const target = prng.nextFloat() * total;
    // The first index whose running total passes the target. Zero weights never pass it.
    let low = 0;
    let high = last;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((cumulative[middle] ?? 0) > target) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }
    return values[low] ?? values[0] ?? '';
  };
}

function isGeneratedDocument(value: unknown): value is GeneratedDocument {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/** Reads a dotted path out of the document built so far. Undefined when a segment is missing. */
export function readPath(doc: GeneratedDocument, segments: readonly string[]): unknown {
  let current: unknown = doc;
  for (const segment of segments) {
    if (!isGeneratedDocument(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

interface NameSources {
  readonly first: readonly string[] | undefined;
  readonly last: readonly string[] | undefined;
}

interface CompileContext {
  readonly prng: Prng;
  readonly toObjectId: (hex: string) => unknown;
  readonly names: NameSources;
}

/** Whether a generator can never repeat, so a unique flag needs no check. */
export function isFreeUnique(generator: GeneratorSpec): boolean {
  return (
    generator.type === 'objectId' || generator.type === 'guid' || generator.type === 'sequence'
  );
}

/**
 * The number of distinct values a generator can produce. Infinity means the space is too large
 * to limit a run, or that the generator never repeats.
 */
export function valueSpace(generator: GeneratorSpec): number {
  switch (generator.type) {
    case 'integer':
      return generator.max - generator.min + 1;
    case 'decimal':
      return Math.round((generator.max - generator.min) * 10 ** generator.precision) + 1;
    case 'boolean':
      return 2;
    case 'dateTime':
      return Date.parse(generator.to) - Date.parse(generator.from) + 1;
    case 'pick': {
      const distinct = new Set<string>();
      generator.values.forEach((value, index) => {
        if ((generator.weights?.[index] ?? 1) > 0) {
          distinct.add(`${typeof value}:${String(value)}`);
        }
      });
      return distinct.size;
    }
    case 'firstName':
      return FIRST_NAMES.length;
    case 'lastName':
      return LAST_NAMES.length;
    case 'fullName':
      return FIRST_NAMES.length * LAST_NAMES.length;
    case 'email':
      return FIRST_NAMES.length * LAST_NAMES.length * generator.domains.length;
    case 'word':
      return LOREM_WORDS.length;
    case 'objectId':
    case 'guid':
    case 'sequence':
    case 'path':
    case 'sentence':
    case 'paragraph':
      return Infinity;
    default: {
      const unreachable: never = generator;
      return unreachable;
    }
  }
}

/**
 * The reasons a job cannot run with these fields and this count, as messages for the user. An
 * empty list means the job can run. A unique field needs at least `count` distinct values, and a
 * sequence must stay inside the safe integer range.
 */
export function generateProblems(fields: readonly GenerateField[], count: number): string[] {
  const problems: string[] = [];
  for (const field of fields) {
    const { generator } = field;
    if (field.unique && !isFreeUnique(generator)) {
      const space = valueSpace(generator);
      if (space < count) {
        problems.push(
          `The field "${field.name}" is unique, but it has only ${space} distinct values. ${count} documents need at least ${count}.`,
        );
      }
    }
    if (generator.type === 'sequence') {
      const last = generator.start + (count - 1) * generator.step;
      if (!Number.isSafeInteger(last)) {
        problems.push(
          `The sequence "${field.name}" would pass the safe integer range within ${count} documents.`,
        );
      }
    }
  }
  return problems;
}

/** Compiles one generator into a closure. The switch runs here, once, not for each document. */
function compileGenerator(generator: GeneratorSpec, context: CompileContext): ValueFn {
  const { prng } = context;
  switch (generator.type) {
    case 'objectId':
      return () => context.toObjectId(objectIdHex(prng));
    case 'guid':
      return () => guidString(prng);
    case 'integer': {
      const { min, max } = generator;
      return () => integerValue(prng, min, max);
    }
    case 'decimal': {
      const { min, max, precision } = generator;
      return () => decimalValue(prng, min, max, precision);
    }
    case 'boolean': {
      const { trueProbability } = generator;
      return () => booleanValue(prng, trueProbability);
    }
    case 'dateTime': {
      const fromMs = Date.parse(generator.from);
      const toMs = Date.parse(generator.to);
      return () => dateValue(prng, fromMs, toMs);
    }
    case 'path': {
      const { depth, extensions } = generator;
      return () => pathValue(prng, depth, extensions);
    }
    case 'firstName':
      return () => firstNameValue(prng);
    case 'lastName':
      return () => lastNameValue(prng);
    case 'fullName':
      return () => `${firstNameValue(prng)} ${lastNameValue(prng)}`;
    case 'email': {
      const { domains } = generator;
      const { first, last } = context.names;
      return (doc) => {
        const firstName = first === undefined ? undefined : readPath(doc, first);
        const lastName = last === undefined ? undefined : readPath(doc, last);
        return emailValue(
          prng,
          domains,
          typeof firstName === 'string' ? firstName : undefined,
          typeof lastName === 'string' ? lastName : undefined,
        );
      };
    }
    case 'word':
      return () => wordValue(prng);
    case 'sentence':
      return () => sentenceValue(prng);
    case 'paragraph':
      return () => paragraphValue(prng);
    case 'pick': {
      const pick = pickFn(prng, generator.values, generator.weights);
      return () => pick();
    }
    case 'sequence': {
      let current = generator.start;
      const step = generator.step;
      return () => {
        const value = current;
        current += step;
        return value;
      };
    }
    default: {
      const unreachable: never = generator;
      throw new Error(`Unknown generator ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Keys a value for the run's Set. Dates use their time, other values are primitives. */
function uniqueKey(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

/**
 * Wraps a draw so each value is new in this run. A repeat is redrawn up to MAX_RESAMPLES times.
 * An integer then walks forward through its range, so a dense range still fills. The walk stops
 * after one lap of the space, which is the `space` count.
 */
function uniqueValue(
  name: string,
  draw: ValueFn,
  next: ((value: unknown) => unknown) | undefined,
  space: number,
): ValueFn {
  const seen = new Set<unknown>();
  return (doc) => {
    let value = draw(doc);
    let tries = 0;
    while (seen.has(uniqueKey(value))) {
      tries += 1;
      if (tries <= MAX_RESAMPLES) {
        value = draw(doc);
      } else if (next !== undefined && tries <= MAX_RESAMPLES + space) {
        value = next(value);
      } else {
        throw new AppErrorException(
          appError(
            'VALIDATION',
            `The field "${name}" ran out of unique values after ${tries} tries.`,
          ),
        );
      }
    }
    seen.add(uniqueKey(value));
    return value;
  };
}

function compileField(field: GenerateField, context: CompileContext): ValueFn {
  const base = compileGenerator(field.generator, context);
  if (!field.unique || isFreeUnique(field.generator)) {
    return base;
  }
  const { generator } = field;
  if (generator.type === 'integer') {
    const { min, max } = generator;
    return uniqueValue(
      field.name,
      base,
      (value) => (value === max ? min : (value as number) + 1),
      valueSpace(generator),
    );
  }
  return uniqueValue(field.name, base, undefined, 0);
}

function nameSourcesOf(fields: readonly GenerateField[]): NameSources {
  const firstField = fields.find((field) => field.generator.type === 'firstName');
  const lastField = fields.find((field) => field.generator.type === 'lastName');
  return {
    first: firstField === undefined ? undefined : firstField.name.split('.'),
    last: lastField === undefined ? undefined : lastField.name.split('.'),
  };
}

/** Writes a value under a dotted path, creating the parent objects the first time. */
function setterFor(name: string, value: ValueFn): (doc: GeneratedDocument) => void {
  const segments = name.split('.');
  const key = segments[segments.length - 1] ?? name;
  const parents = segments.slice(0, -1);
  if (parents.length === 0) {
    return (doc) => {
      doc[key] = value(doc);
    };
  }
  return (doc) => {
    let target = doc;
    for (const parent of parents) {
      target = childOf(target, parent);
    }
    target[key] = value(doc);
  };
}

function childOf(target: GeneratedDocument, key: string): GeneratedDocument {
  const existing = target[key];
  if (isGeneratedDocument(existing)) {
    return existing;
  }
  const created: GeneratedDocument = {};
  target[key] = created;
  return created;
}

/**
 * Compiles the fields into a factory. Each call of the factory returns one new document. The
 * generators, the uniqueness sets and the sequence counters belong to this compile, so compile
 * once for each job.
 */
export function compileSpec(
  fields: readonly GenerateField[],
  options: CompileOptions,
): () => GeneratedDocument {
  const context: CompileContext = {
    prng: createPrng(options.seed),
    toObjectId: options.toObjectId ?? ((hex) => hex),
    names: nameSourcesOf(fields),
  };
  const setters = fields.map((field) => setterFor(field.name, compileField(field, context)));
  return () => {
    const doc: GeneratedDocument = {};
    for (const set of setters) {
      set(doc);
    }
    return doc;
  };
}
