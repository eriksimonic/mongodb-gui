// Captures explain output from one real MongoDB server into ../<version>/<case>.executionStats.json.
//
// Run one version at a time in the foreground. The script starts its own container with
// Testcontainers on a random host port, seeds the capture database, runs each case, writes the
// fixtures, and stops the container. Nothing connects to port 27017.
//
//   node --experimental-strip-types packages/core/src/explain/fixtures/capture/capture-explain.ts 6.0
//
// This is a developer script, not core runtime code. It imports the driver and Testcontainers,
// which core may not import. tests/support/boundaries.ts and eslint.config.js exempt this directory.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BSON, MongoClient, type Db, type Document } from 'mongodb';
import { GenericContainer, Wait } from 'testcontainers';

const SUPPORTED_VERSIONS = ['4.4', '6.0', '8.0.17'] as const;
type Version = (typeof SUPPORTED_VERSIONS)[number];

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(SCRIPT_DIR, '..');
const DB_NAME = 'explain_capture';
const MONGO_PORT = 27017;
const PLACE_COUNT = 3000;
const CUSTOMER_COUNT = 300;
const READING_COUNT = 500;
const CLUSTERED_COUNT = 100;
const CUISINES = ['thai', 'pizza', 'burger', 'sushi', 'vegan'] as const;
const TIERS = ['gold', 'silver', 'bronze'] as const;
const TAGS = ['coffee', 'bar', 'food', 'outdoor'] as const;
const DEFAULT_LIMIT = 100 * 1024 * 1024;

interface CaseDef {
  readonly name: string;
  // Lowest major server version that runs the case. Cases below it are skipped.
  readonly minMajor: number;
  // The command to explain, without the explain wrapper.
  readonly command: Document;
  // Server parameters set for the case and reset to their defaults afterwards.
  readonly params?: Record<string, number>;
  // Runs the command this many times before the explain, so a plan cache entry exists.
  readonly prime?: number;
}

const CASES: readonly CaseDef[] = [
  {
    name: 'text-search',
    minMajor: 4,
    command: { find: 'places', filter: { $text: { $search: 'coffee' } } },
  },
  {
    name: 'geo-2dsphere',
    minMajor: 4,
    command: {
      find: 'places',
      filter: {
        loc: {
          $near: {
            $geometry: { type: 'Point', coordinates: [16.37, 48.2] },
            $maxDistance: 5000,
          },
        },
      },
    },
  },
  {
    name: 'geo-2d',
    minMajor: 4,
    command: { find: 'places', filter: { pos: { $near: [16.37, 48.2] } } },
  },
  {
    name: 'geo-near-aggregate',
    minMajor: 4,
    command: {
      aggregate: 'places',
      pipeline: [
        {
          $geoNear: {
            near: { type: 'Point', coordinates: [16.37, 48.2] },
            distanceField: 'dist',
            key: 'loc',
            spherical: true,
          },
        },
        { $limit: 5 },
      ],
      cursor: {},
    },
  },
  {
    name: 'and-hash',
    minMajor: 4,
    command: { find: 'places', filter: { open: true, rating: 5 } },
  },
  {
    name: 'sort-merge',
    minMajor: 4,
    command: {
      find: 'places',
      filter: { $or: [{ cuisine: 'thai' }, { cuisine: 'pizza' }] },
      sort: { rating: -1 },
    },
  },
  {
    name: 'idhack',
    minMajor: 4,
    command: { find: 'places', filter: { _id: 17 } },
  },
  {
    name: 'express-unique',
    minMajor: 4,
    command: { find: 'places', filter: { code: 'C42' } },
  },
  {
    name: 'clustered-id',
    minMajor: 6,
    command: { find: 'clustered', filter: { _id: 5 } },
  },
  {
    name: 'update-express',
    minMajor: 4,
    command: {
      update: 'places',
      updates: [{ q: { code: 'C42' }, u: { $set: { notes: 'checked' } } }],
    },
  },
  {
    name: 'delete-express',
    minMajor: 4,
    command: { delete: 'places', deletes: [{ q: { code: 'C43' }, limit: 1 }] },
  },
  {
    name: 'delete-many',
    minMajor: 4,
    command: { delete: 'places', deletes: [{ q: { open: false }, limit: 0 }] },
  },
  {
    name: 'sort-spill',
    minMajor: 4,
    params: { internalQueryMaxBlockingSortMemoryUsageBytes: 65536 },
    command: { find: 'places', filter: {}, sort: { name: 1 }, allowDiskUse: true },
  },
  {
    name: 'group-spill',
    minMajor: 4,
    params: { internalDocumentSourceGroupMaxMemoryBytes: 65536 },
    command: {
      aggregate: 'places',
      pipeline: [{ $group: { _id: '$name', n: { $sum: 1 } } }],
      cursor: {},
      allowDiskUse: true,
    },
  },
  {
    name: 'group-plain',
    minMajor: 4,
    command: {
      aggregate: 'places',
      pipeline: [
        { $match: { cuisine: 'thai' } },
        { $group: { _id: '$rating', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ],
      cursor: {},
    },
  },
  {
    name: 'lookup-pipeline',
    minMajor: 4,
    command: {
      aggregate: 'places',
      pipeline: [
        { $match: { cuisine: 'thai' } },
        {
          $lookup: {
            from: 'customers',
            let: { c: '$cuisine' },
            pipeline: [{ $match: { $expr: { $eq: ['$region', '$$c'] } } }, { $limit: 3 }],
            as: 'matches',
          },
        },
      ],
      cursor: {},
    },
  },
  {
    name: 'lookup-indexed',
    minMajor: 4,
    command: {
      aggregate: 'places',
      pipeline: [
        { $match: { cuisine: 'thai' } },
        { $lookup: { from: 'customers', localField: 'cuisine', foreignField: 'region', as: 'm' } },
      ],
      cursor: {},
    },
  },
  {
    name: 'lookup-unindexed',
    minMajor: 4,
    command: {
      aggregate: 'places',
      pipeline: [
        { $match: { cuisine: 'thai' } },
        { $lookup: { from: 'customers', localField: 'cuisine', foreignField: 'tier', as: 'm' } },
      ],
      cursor: {},
    },
  },
  {
    name: 'union-with',
    minMajor: 4,
    command: {
      aggregate: 'places',
      pipeline: [
        { $match: { cuisine: 'thai' } },
        { $unionWith: { coll: 'customers', pipeline: [{ $match: { tier: 'gold' } }] } },
      ],
      cursor: {},
    },
  },
  {
    name: 'facet',
    minMajor: 4,
    command: {
      aggregate: 'places',
      pipeline: [
        { $match: { open: true } },
        {
          $facet: {
            byRating: [{ $sortByCount: '$rating' }],
            total: [{ $count: 'n' }],
          },
        },
      ],
      cursor: {},
    },
  },
  {
    name: 'graph-lookup',
    minMajor: 4,
    command: {
      aggregate: 'customers',
      pipeline: [
        { $match: { _id: 5 } },
        {
          $graphLookup: {
            from: 'customers',
            startWith: '$referredBy',
            connectFromField: 'referredBy',
            connectToField: '_id',
            as: 'chain',
            maxDepth: 3,
          },
        },
      ],
      cursor: {},
    },
  },
  {
    name: 'pipeline-stages',
    minMajor: 4,
    command: {
      aggregate: 'places',
      pipeline: [
        { $match: { cuisine: 'thai' } },
        { $unwind: '$tags' },
        { $addFields: { score: { $multiply: ['$rating', 2] } } },
        { $project: { name: 1, score: 1 } },
        { $sort: { score: -1 } },
        { $skip: 1 },
        { $limit: 5 },
        { $count: 'n' },
      ],
      cursor: {},
    },
  },
  {
    name: 'out-stage',
    minMajor: 4,
    command: {
      aggregate: 'places',
      pipeline: [{ $match: { cuisine: 'thai' } }, { $out: 'places_out' }],
      cursor: {},
    },
  },
  {
    name: 'merge-stage',
    minMajor: 4,
    command: {
      aggregate: 'places',
      pipeline: [
        { $match: { cuisine: 'thai' } },
        {
          $merge: {
            into: 'places_merged',
            on: '_id',
            whenMatched: 'keepExisting',
            whenNotMatched: 'insert',
          },
        },
      ],
      cursor: {},
    },
  },
  {
    name: 'timeseries-find',
    minMajor: 6,
    command: { find: 'readings', filter: { 'meta.sensor': 's1' }, sort: { t: -1 } },
  },
  {
    name: 'limit-skip',
    minMajor: 4,
    command: {
      find: 'places',
      filter: { cuisine: 'thai' },
      sort: { rating: -1 },
      skip: 5,
      limit: 10,
    },
  },
  {
    name: 'projection-default',
    minMajor: 4,
    command: { find: 'places', filter: { cuisine: 'thai' }, projection: { name: 1, notes: 1 } },
  },
  {
    name: 'cached-plan',
    minMajor: 4,
    prime: 3,
    command: { find: 'places', filter: { cuisine: 'pizza', rating: { $gt: 3 } } },
  },
  {
    name: 'or-subplan',
    minMajor: 4,
    command: {
      find: 'places',
      filter: { $or: [{ cuisine: 'thai', rating: 5 }, { tags: 'bar', open: true }] },
    },
  },
];

// Explain output is kept as canonical EJSON. The driver promotes nothing, as the adapter does.
const RAW_OPTIONS = { promoteValues: false, promoteLongs: false };

async function main(): Promise<void> {
  const version = parseVersion(process.argv[2]);
  const image = `mongo:${version}`;
  const outDir = join(FIXTURE_ROOT, version);
  mkdirSync(outDir, { recursive: true });
  console.log(`starting ${image}`);
  const container = await new GenericContainer(image)
    .withExposedPorts(MONGO_PORT)
    .withWaitStrategy(
      Wait.forAll([Wait.forListeningPorts(), Wait.forLogMessage(/Waiting for connections/, 1)]),
    )
    .withStartupTimeout(300_000)
    .start();
  const uri = `mongodb://${container.getHost()}:${container.getMappedPort(MONGO_PORT)}/`;
  const client = new MongoClient(uri, { directConnection: true });
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const major = await serverMajor(db);
    console.log(`server ${major}.x at ${uri}`);
    await seed(db, major);
    const report: string[] = [];
    for (const testCase of CASES) {
      report.push(await captureCase(db, testCase, major, outDir));
    }
    console.log(report.join('\n'));
  } finally {
    await client.close();
    await container.stop();
    console.log(`stopped ${image}`);
  }
}

function parseVersion(text: string | undefined): Version {
  const match = SUPPORTED_VERSIONS.find((version) => version === text);
  if (match === undefined) {
    throw new Error(`usage: capture-explain.ts <${SUPPORTED_VERSIONS.join('|')}>`);
  }
  return match;
}

async function serverMajor(db: Db): Promise<number> {
  const info = await db.admin().command({ buildInfo: 1 });
  return Number(String(info['version']).split('.')[0]);
}

// Seeds every collection the cases read. Inserts are unordered and the indexes come after the
// data, so the planner sees the same shape on each version.
async function seed(db: Db, major: number): Promise<void> {
  await db.dropDatabase();
  const places: Document[] = Array.from({ length: PLACE_COUNT }, (_, i) => {
    const cuisine = CUISINES[i % CUISINES.length] ?? "thai";
    const tags = [TAGS[i % TAGS.length], TAGS[(i * 7) % TAGS.length]];
    return {
      _id: i,
      name: `Place ${i} ${'x'.repeat(120)}`,
      cuisine,
      rating: (i % 5) + 1,
      open: i % 3 !== 0,
      tags,
      description: `${cuisine} place with ${tags.join(' ')}`,
      code: `C${i}`,
      loc: { type: 'Point', coordinates: [16.2 + (i % 50) / 100, 48.0 + (i % 40) / 100] },
      pos: [16.2 + (i % 50) / 100, 48.0 + (i % 40) / 100],
      region: CUISINES[(i * 3) % CUISINES.length],
    };
  });
  await db.collection('places').insertMany(places, { ordered: false });
  await db.collection('places').createIndexes([
    { key: { cuisine: 1, rating: -1 }, name: 'cuisine_1_rating_-1' },
    { key: { open: 1 }, name: 'open_1' },
    { key: { rating: 1 }, name: 'rating_1' },
    { key: { description: 'text' }, name: 'description_text' },
    { key: { loc: '2dsphere' }, name: 'loc_2dsphere' },
    { key: { pos: '2d' }, name: 'pos_2d' },
    { key: { code: 1 }, name: 'code_1', unique: true },
  ]);
  const customers: Document[] = Array.from({ length: CUSTOMER_COUNT }, (_, i) => ({
    _id: i,
    region: CUISINES[i % CUISINES.length],
    tier: TIERS[i % TIERS.length],
    referredBy: i === 0 ? null : i - 1,
  }));
  await db.collection('customers').insertMany(customers, { ordered: false });
  await db.collection('customers').createIndex({ region: 1 }, { name: 'region_1' });
  if (major >= 6) {
    await db.createCollection('clustered', {
      clusteredIndex: { key: { _id: 1 }, unique: true, name: 'clustered key' },
    });
    const clustered: Document[] = Array.from({ length: CLUSTERED_COUNT }, (_, i) => ({ _id: i, v: i }));
    await db.collection('clustered').insertMany(clustered, { ordered: false });
    await db.createCollection('readings', {
      timeseries: { timeField: 't', metaField: 'meta', granularity: 'minutes' },
    });
    const readings: Document[] = Array.from({ length: READING_COUNT }, (_, i) => ({
      t: new Date(Date.UTC(2026, 0, 1) + i * 60_000),
      meta: { sensor: i % 2 === 0 ? 's1' : 's2' },
      value: i,
    }));
    await db.collection('readings').insertMany(readings, { ordered: false });
  }
}

async function captureCase(
  db: Db,
  testCase: CaseDef,
  major: number,
  outDir: string,
): Promise<string> {
  if (major < testCase.minMajor) {
    return `skip ${testCase.name}: needs server ${testCase.minMajor}.0 or newer`;
  }
  try {
    await setParams(db, testCase.params ?? {});
    for (let run = 0; run < (testCase.prime ?? 0); run += 1) {
      await db.command(testCase.command, RAW_OPTIONS);
    }
    const raw: unknown = await db.command(
      { explain: testCase.command, verbosity: 'executionStats' },
      RAW_OPTIONS,
    );
    const canonical = BSON.EJSON.serialize(raw as Document, { relaxed: false });
    writeFileSync(
      join(outDir, `${testCase.name}.executionStats.json`),
      `${JSON.stringify(canonical, null, 2)}\n`,
    );
    return `wrote ${testCase.name}`;
  } catch (error) {
    return `fail ${testCase.name}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await setParams(db, defaultsFor(testCase.params));
  }
}

function defaultsFor(params: Record<string, number> | undefined): Record<string, number> {
  const defaults: Record<string, number> = {};
  for (const key of Object.keys(params ?? {})) {
    defaults[key] = DEFAULT_LIMIT;
  }
  return defaults;
}

async function setParams(db: Db, params: Record<string, number>): Promise<void> {
  if (Object.keys(params).length === 0) {
    return;
  }
  await db.admin().command({ setParameter: 1, ...params });
}

await main();
