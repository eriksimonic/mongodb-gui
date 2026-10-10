import { describe, expect, it } from 'vitest';
import { AppErrorException } from '../domain/errors';
import {
  compileSpec,
  createPrng,
  generateProblems,
  valueSpace,
  type GeneratedDocument,
} from './generators';
import {
  fieldNameProblem,
  GenerateFieldSchema,
  GenerateStartInputSchema,
  type GenerateField,
} from './spec';

const CONNECTION_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMAIL = /^[a-z]+\.[a-z]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function field(name: string, generator: GenerateField['generator'], unique = false): GenerateField {
  return { name, generator, unique };
}

function run(fields: GenerateField[], count: number, seed = 42): GeneratedDocument[] {
  const factory = compileSpec(fields, { seed });
  return Array.from({ length: count }, () => factory());
}

describe('createPrng', () => {
  it('gives the same sequence for the same seed and a different one for another seed', () => {
    const first = createPrng(7);
    const second = createPrng(7);
    const other = createPrng(8);
    const a = [first.nextUint32(), first.nextUint32(), first.nextUint32()];
    const b = [second.nextUint32(), second.nextUint32(), second.nextUint32()];
    expect(a).toEqual(b);
    expect(other.nextUint32()).not.toBe(a[0]);
  });

  it('keeps nextInt inside the inclusive range', () => {
    const prng = createPrng(1);
    for (let index = 0; index < 10_000; index += 1) {
      const value = prng.nextInt(-3, 4);
      expect(value).toBeGreaterThanOrEqual(-3);
      expect(value).toBeLessThanOrEqual(4);
    }
  });
});

describe('compileSpec determinism', () => {
  const fields: GenerateField[] = [
    field('_id', { type: 'objectId' }),
    field('code', { type: 'guid' }),
    field('qty', { type: 'integer', min: 1, max: 50 }),
    field('price', { type: 'decimal', min: 1, max: 100, precision: 2 }),
    field('active', { type: 'boolean', trueProbability: 0.5 }),
    field('created', {
      type: 'dateTime',
      from: '2024-01-01T00:00:00.000Z',
      to: '2026-12-31T23:59:59.000Z',
    }),
    field('file', { type: 'path', depth: 3, extensions: ['csv', 'json'] }),
    field('first', { type: 'firstName' }),
    field('last', { type: 'lastName' }),
    field('email', { type: 'email', domains: ['example.com'] }),
    field('note', { type: 'paragraph' }),
  ];

  it('gives identical documents for the same seed', () => {
    expect(run(fields, 50, 99)).toEqual(run(fields, 50, 99));
  });

  it('gives different documents for another seed', () => {
    expect(run(fields, 5, 1)).not.toEqual(run(fields, 5, 2));
  });

  it('builds dotted paths as nested objects', () => {
    const [doc] = run(
      [
        field('address.city', { type: 'firstName' }),
        field('address.zip', { type: 'integer', min: 1, max: 9 }),
      ],
      1,
    );
    expect(doc).toEqual({ address: { city: expect.any(String), zip: expect.any(Number) } });
  });
});

describe('generator ranges and formats', () => {
  it('keeps integers, decimals and dates inside their bounds', () => {
    const docs = run(
      [
        field('i', { type: 'integer', min: -5, max: 5 }),
        field('d', { type: 'decimal', min: 1.5, max: 2.5, precision: 1 }),
        field('t', {
          type: 'dateTime',
          from: '2025-01-01T00:00:00.000Z',
          to: '2025-01-02T00:00:00.000Z',
        }),
      ],
      2000,
    );
    for (const doc of docs) {
      expect(Number.isInteger(doc['i'])).toBe(true);
      expect(doc['i'] as number).toBeGreaterThanOrEqual(-5);
      expect(doc['i'] as number).toBeLessThanOrEqual(5);
      const decimal = doc['d'] as number;
      expect(decimal).toBeGreaterThanOrEqual(1.5);
      expect(decimal).toBeLessThanOrEqual(2.5);
      expect(Math.round(decimal * 10) / 10).toBe(decimal);
      const date = doc['t'];
      expect(date).toBeInstanceOf(Date);
      expect((date as Date).getTime()).toBeGreaterThanOrEqual(
        Date.parse('2025-01-01T00:00:00.000Z'),
      );
      expect((date as Date).getTime()).toBeLessThanOrEqual(Date.parse('2025-01-02T00:00:00.000Z'));
    }
  });

  it('follows the true probability for booleans', () => {
    const docs = run([field('b', { type: 'boolean', trueProbability: 0.8 })], 20_000);
    const trues = docs.filter((doc) => doc['b'] === true).length;
    expect(trues / docs.length).toBeGreaterThan(0.78);
    expect(trues / docs.length).toBeLessThan(0.82);
  });

  it('writes guids as version 4 UUIDs and object ids as 24 hex characters', () => {
    const docs = run([field('g', { type: 'guid' }), field('o', { type: 'objectId' })], 200);
    for (const doc of docs) {
      expect(doc['g']).toMatch(UUID_V4);
      expect(doc['o']).toMatch(/^[0-9a-f]{24}$/);
    }
  });

  it('passes object ids through the toObjectId hook', () => {
    const factory = compileSpec([field('_id', { type: 'objectId' })], {
      seed: 3,
      toObjectId: (hex) => ({ wrapped: hex }),
    });
    expect(factory()).toEqual({ _id: { wrapped: expect.stringMatching(/^[0-9a-f]{24}$/) } });
  });

  it('writes emails in the address format on the configured domains', () => {
    const docs = run(
      [field('email', { type: 'email', domains: ['example.com', 'mail.example.org'] })],
      500,
    );
    for (const doc of docs) {
      expect(doc['email']).toMatch(EMAIL);
      expect(String(doc['email'])).toMatch(/@(example\.com|mail\.example\.org)$/);
    }
  });

  it('derives the email from the first and last name of the same document', () => {
    const docs = run(
      [
        field('first', { type: 'firstName' }),
        field('last', { type: 'lastName' }),
        field('email', { type: 'email', domains: ['example.com'] }),
      ],
      200,
    );
    for (const doc of docs) {
      expect(doc['email']).toBe(`${String(doc['first'])}.${String(doc['last'])}@example.com`);
    }
  });

  it('writes paths with the depth and extension asked for', () => {
    const docs = run([field('p', { type: 'path', depth: 4, extensions: ['csv', 'json'] })], 300);
    for (const doc of docs) {
      expect(doc['p']).toMatch(/^(\/[a-z0-9]+){4}\/[a-z]+-[1-9][0-9]{0,5}\.(csv|json)$/);
    }
  });

  it('writes words, sentences and paragraphs from the lorem list', () => {
    const docs = run(
      [
        field('w', { type: 'word' }),
        field('s', { type: 'sentence' }),
        field('p', { type: 'paragraph' }),
      ],
      1,
    );
    const doc: GeneratedDocument = docs[0] ?? {};
    expect(doc['w']).toMatch(/^[a-z]+$/);
    expect(doc['s']).toMatch(/^[A-Z][a-z]+( [a-z]+)*\.$/);
    expect(doc['p']).toMatch(/\.$/);
  });

  it('picks only listed values and never a zero-weight value', () => {
    const docs = run(
      [
        field('colour', { type: 'pick', values: ['red', 'green', 'blue'] }),
        field('weighted', { type: 'pick', values: ['a', 'b', 'c'], weights: [1, 0, 3] }),
      ],
      3000,
    );
    expect(new Set(docs.map((doc) => doc['colour']))).toEqual(new Set(['red', 'green', 'blue']));
    expect(docs.some((doc) => doc['weighted'] === 'b')).toBe(false);
    const threes = docs.filter((doc) => doc['weighted'] === 'c').length;
    expect(threes / docs.length).toBeGreaterThan(0.7);
  });

  it('counts a sequence from its start by its step', () => {
    const docs = run([field('n', { type: 'sequence', start: 10, step: 5 })], 4);
    expect(docs.map((doc) => doc['n'])).toEqual([10, 15, 20, 25]);
  });
});

describe('unique fields', () => {
  it('gives distinct values for a dense integer range', () => {
    const docs = run([field('n', { type: 'integer', min: 1, max: 1000 }, true)], 1000);
    expect(new Set(docs.map((doc) => doc['n'])).size).toBe(1000);
  });

  it('gives distinct dates, names and strings', () => {
    const docs = run(
      [
        field(
          't',
          { type: 'dateTime', from: '2025-01-01T00:00:00.000Z', to: '2025-01-01T00:00:01.000Z' },
          true,
        ),
        field('f', { type: 'firstName' }, true),
        field('w', { type: 'word' }, true),
      ],
      150,
    );
    expect(new Set(docs.map((doc) => (doc['t'] as Date).getTime())).size).toBe(150);
    expect(new Set(docs.map((doc) => doc['f'])).size).toBe(150);
    expect(new Set(docs.map((doc) => doc['w'])).size).toBe(150);
  });

  it('gives distinct guids and sequence values without a check', () => {
    const docs = run(
      [
        field('g', { type: 'guid' }, true),
        field('s', { type: 'sequence', start: 1, step: 1 }, true),
      ],
      2000,
    );
    expect(new Set(docs.map((doc) => doc['g'])).size).toBe(2000);
    expect(new Set(docs.map((doc) => doc['s'])).size).toBe(2000);
  });

  it('rejects a unique field whose value space is smaller than the count', () => {
    const fields = [field('n', { type: 'integer', min: 1, max: 100 }, true)];
    expect(generateProblems(fields, 1000)).toEqual([
      'The field "n" is unique, but it has only 100 distinct values. 1000 documents need at least 1000.',
    ]);
    expect(generateProblems(fields, 100)).toEqual([]);
  });

  it('rejects the same configuration in the job schema', () => {
    const input = {
      connectionId: CONNECTION_ID,
      database: 'shop',
      collection: 'orders',
      count: 1000,
      seed: 1,
      fields: [field('n', { type: 'integer', min: 1, max: 100 }, true)],
    };
    const result = GenerateStartInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('computes the value space of each generator', () => {
    expect(valueSpace({ type: 'integer', min: 1, max: 100 })).toBe(100);
    expect(valueSpace({ type: 'boolean', trueProbability: 0.5 })).toBe(2);
    expect(valueSpace({ type: 'pick', values: ['a', 'a', 'b'] })).toBe(2);
    expect(valueSpace({ type: 'objectId' })).toBe(Infinity);
  });

  it('reports a sequence that would leave the safe integer range', () => {
    const problems = generateProblems(
      [field('s', { type: 'sequence', start: 9_000_000_000_000_000, step: 1_000_000 })],
      10_000_000,
    );
    expect(problems).toHaveLength(1);
  });
});

describe('field names', () => {
  it('accepts sibling paths and refuses duplicates and nesting under a value', () => {
    expect(fieldNameProblem(['address.city', 'address.zip', 'name'])).toBeUndefined();
    expect(fieldNameProblem(['a', 'a'])).toContain('listed more than once');
    expect(fieldNameProblem(['address', 'address.city'])).toContain('cannot be nested');
  });

  it('refuses an empty path segment in a field', () => {
    expect(
      GenerateFieldSchema.safeParse({ name: 'a..b', generator: { type: 'word' } }).success,
    ).toBe(false);
  });
});

describe('spec validation', () => {
  it('refuses a minimum above the maximum and a bad domain', () => {
    expect(
      GenerateFieldSchema.safeParse({ name: 'n', generator: { type: 'integer', min: 5, max: 1 } })
        .success,
    ).toBe(false);
    expect(
      GenerateFieldSchema.safeParse({
        name: 'e',
        generator: { type: 'email', domains: ['Bad Domain'] },
      }).success,
    ).toBe(false);
  });

  it('refuses a date range that ends before it starts', () => {
    const result = GenerateFieldSchema.safeParse({
      name: 't',
      generator: { type: 'dateTime', from: '2026-01-01T00:00:00Z', to: '2025-01-01T00:00:00Z' },
    });
    expect(result.success).toBe(false);
  });
});

describe('throughput', () => {
  it('generates 100,000 documents of 8 fields in under 2 seconds', () => {
    const fields: GenerateField[] = [
      field('_id', { type: 'objectId' }),
      field('sku', { type: 'guid' }),
      field('qty', { type: 'integer', min: 1, max: 500 }),
      field('price', { type: 'decimal', min: 1, max: 999, precision: 2 }),
      field('when', { type: 'dateTime', from: '2020-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' }),
      field('name', { type: 'fullName' }),
      field('mail', { type: 'email', domains: ['example.com'] }),
      field('file', { type: 'path', depth: 3, extensions: ['csv'] }),
    ];
    const factory = compileSpec(fields, { seed: 2026 });
    const started = performance.now();
    let generated = 0;
    for (let index = 0; index < 100_000; index += 1) {
      factory();
      generated += 1;
    }
    const elapsed = performance.now() - started;
    expect(generated).toBe(100_000);
    // Surfaced in the test output so the measured rate can be read from a run.
    console.info(`generated 100000 documents of 8 fields in ${elapsed.toFixed(0)} ms`);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('errors', () => {
  it('throws an AppErrorException when a unique draw is exhausted', () => {
    // A single-value pick can never give a second distinct value, so the walk gives up.
    const factory = compileSpec([field('p', { type: 'pick', values: ['only'] }, true)], {
      seed: 1,
    });
    factory();
    expect(() => factory()).toThrow(AppErrorException);
  });
});
