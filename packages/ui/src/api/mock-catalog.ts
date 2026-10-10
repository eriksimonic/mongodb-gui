import type {
  CollectionInfo,
  IndexBuildProgress,
  IndexInfo,
  ValidationRules,
} from '@mongo-gui/core';
import { bsonSampleDocuments } from './mock-bson-fixtures';
import { localConnectionId, stagingConnectionId } from './mock-fixtures';

/** Documents in the shop's bson_samples collection, which holds every BSON type. */
export const BSON_SAMPLE_COUNT = 12;

/** A document as the mock stores it. Values use plain JSON, with `$oid` and friends for BSON. */
export type MockDocument = Record<string, unknown>;

export interface MockCollection {
  info: CollectionInfo;
  documents: MockDocument[];
  indexes: IndexInfo[];
  validator: MockDocument;
  validationLevel: ValidationRules['validationLevel'];
  validationAction: ValidationRules['validationAction'];
}

export interface MockDatabase {
  name: string;
  sizeOnDisk: number;
  collections: MockCollection[];
}

/** An index build the mock reports until it finishes. Progress is derived from the clock. */
export interface MockBuild {
  readonly database: string;
  readonly collection: string;
  readonly indexName: string;
  readonly startedAt: number;
  readonly opid: number;
}

/** Most documents a mock collection keeps. Counts above this are shown but not stored. */
export const MOCK_MAX_DOCUMENTS = 240;
export const BUILD_DURATION_MS = 60_000;
const OBJECT_ID_HEX_LENGTH = 24;
const ID_INDEX_SIZE = 20_480;
const PERCENT = 100;

export function isMockDocument(value: unknown): value is MockDocument {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function objectIdHex(seed: number): string {
  return seed.toString(16).padStart(OBJECT_ID_HEX_LENGTH, '0');
}

export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Equality, or membership for `{ $in: [...] }`. Other operators are not supported by the mock. */
function fieldMatches(actual: unknown, expected: unknown): boolean {
  if (isMockDocument(expected) && Array.isArray(expected.$in)) {
    const choices: unknown[] = expected.$in;
    return choices.some((choice) => sameJson(actual, choice));
  }
  return sameJson(actual, expected);
}

/** Top-level equality and `$in` only. The mock says so in its docs. */
export function matchesFilter(document: MockDocument, filter: MockDocument): boolean {
  return Object.entries(filter).every(([field, expected]) =>
    fieldMatches(document[field], expected),
  );
}

function bsonTypeMatches(value: unknown, bsonType: string): boolean {
  switch (bsonType) {
    case 'string':
      return typeof value === 'string';
    case 'bool':
      return typeof value === 'boolean';
    case 'object':
      return isMockDocument(value);
    case 'array':
      return Array.isArray(value);
    case 'int':
    case 'long':
    case 'double':
    case 'number':
      return typeof value === 'number' || (isMockDocument(value) && '$numberLong' in value);
    case 'null':
      return value === null;
    case 'objectId':
      return isMockDocument(value) && '$oid' in value;
    case 'date':
      return isMockDocument(value) && '$date' in value;
    default:
      return true;
  }
}

/** Checks the required fields and the bsonType of the top-level properties. */
function jsonSchemaPasses(document: MockDocument, schema: MockDocument): boolean {
  const required: unknown[] = Array.isArray(schema.required) ? schema.required : [];
  const requiredPresent = required.every((field) => typeof field === 'string' && field in document);
  if (!requiredPresent) {
    return false;
  }
  const properties = isMockDocument(schema.properties) ? schema.properties : {};
  return Object.entries(properties).every(([field, spec]) => {
    if (!(field in document) || !isMockDocument(spec) || typeof spec.bsonType !== 'string') {
      return true;
    }
    return bsonTypeMatches(document[field], spec.bsonType);
  });
}

/** True when the validator rejects the document. An empty validator rejects nothing. */
export function failsValidator(document: MockDocument, validator: MockDocument): boolean {
  if (Object.keys(validator).length === 0) {
    return false;
  }
  const schema = validator.$jsonSchema;
  if (isMockDocument(schema)) {
    return !jsonSchemaPasses(document, schema);
  }
  return !matchesFilter(document, validator);
}

export function defaultIndexName(keys: Record<string, unknown>): string {
  return Object.entries(keys)
    .map(([field, direction]) => `${field}_${String(direction)}`)
    .join('_');
}

export function documentsFor(name: string, count: number): MockDocument[] {
  return Array.from({ length: Math.min(count, MOCK_MAX_DOCUMENTS) }, (_, index) => ({
    _id: { $oid: objectIdHex(index + 1) },
    name: `${name}-${index + 1}`,
    status: index % 3 === 0 ? 'pending' : 'paid',
    customerId: `C-${(index % 40) + 1}`,
    qty: (index % 7) + 1,
  }));
}

function idIndex(): IndexInfo {
  return { name: '_id_', key: { _id: 1 }, size: ID_INDEX_SIZE };
}

interface CollectionSeed {
  readonly name: string;
  readonly count: number;
  readonly type?: CollectionInfo['type'];
  readonly options?: CollectionInfo['options'];
  readonly indexes?: readonly IndexInfo[];
  readonly validator?: MockDocument;
  readonly documents?: readonly MockDocument[];
}

function collectionOf(seed: CollectionSeed): MockCollection {
  const type = seed.type ?? 'collection';
  const info: CollectionInfo = { name: seed.name, type };
  if (seed.options !== undefined) {
    info.options = seed.options;
  }
  return {
    info,
    documents:
      type === 'view' ? [] : (seed.documents?.slice() ?? documentsFor(seed.name, seed.count)),
    indexes: [idIndex(), ...(seed.indexes ?? [])],
    validator: seed.validator ?? {},
    validationLevel: 'strict',
    validationAction: 'error',
  };
}

const ORDERS_VALIDATOR: MockDocument = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['status', 'customerId', 'qty'],
    properties: { status: { bsonType: 'string' }, customerId: { bsonType: 'string' } },
  },
};

const localDatabases: readonly {
  name: string;
  sizeOnDisk: number;
  collections: CollectionSeed[];
}[] = [
  {
    name: 'shop',
    sizeOnDisk: 2_097_152,
    collections: [
      {
        name: 'orders',
        count: 1200,
        validator: ORDERS_VALIDATOR,
        indexes: [
          {
            name: 'status_1_createdAt_-1',
            key: { status: 1, createdAt: -1 },
            size: 36_864,
            usage: { ops: 412, since: '2026-10-01T00:00:00.000Z' },
          },
        ],
      },
      {
        name: 'customers',
        count: 340,
        indexes: [
          {
            name: 'email_1',
            key: { email: 1 },
            unique: true,
            size: 24_576,
            usage: { ops: 58, since: '2026-10-02T00:00:00.000Z' },
          },
        ],
      },
      {
        name: 'paid_orders',
        count: 0,
        type: 'view',
        options: { viewOn: 'orders', pipeline: [{ $match: { status: 'paid' } }] },
      },
      {
        name: 'sensor_readings',
        count: 86_400,
        type: 'timeseries',
        options: {
          timeseries: { timeField: 'ts', metaField: 'sensor', granularity: 'seconds' },
        },
      },
    ],
  },
  {
    name: 'analytics',
    sizeOnDisk: 524_288,
    collections: [
      {
        name: 'bson_samples',
        count: BSON_SAMPLE_COUNT,
        documents: bsonSampleDocuments(BSON_SAMPLE_COUNT),
      },
      {
        name: 'events',
        count: 5400,
        indexes: [{ name: 'createdAt_1', key: { createdAt: 1 }, size: 16_384 }],
      },
      {
        name: 'sessions',
        count: 910,
        indexes: [
          {
            name: 'expiresAt_1',
            key: { expiresAt: 1 },
            expireAfterSeconds: 3600,
            size: 12_288,
          },
        ],
      },
    ],
  },
  {
    name: 'logs',
    sizeOnDisk: 65_536,
    collections: [{ name: 'app_logs', count: 150 }],
  },
];

const stagingDatabases: typeof localDatabases = [
  {
    name: 'shop',
    sizeOnDisk: 8_388_608,
    collections: [
      { name: 'orders', count: 48_000 },
      { name: 'customers', count: 9100 },
    ],
  },
  {
    name: 'billing',
    sizeOnDisk: 1_048_576,
    collections: [
      { name: 'invoices', count: 2300 },
      { name: 'payments', count: 2050 },
    ],
  },
  {
    name: 'users',
    sizeOnDisk: 262_144,
    collections: [{ name: 'accounts', count: 700 }],
  },
];

const fixtureSeeds: Readonly<Record<string, typeof localDatabases>> = {
  [localConnectionId]: localDatabases,
  [stagingConnectionId]: stagingDatabases,
};

/** A fresh catalog for a connection. Unknown connections start with no databases. */
export function fixtureCatalog(connectionId: string): MockDatabase[] {
  return (fixtureSeeds[connectionId] ?? []).map((database) => ({
    name: database.name,
    sizeOnDisk: database.sizeOnDisk,
    collections: database.collections.map(collectionOf),
  }));
}

/** One index build that is already running when the mock starts, so the progress row shows. */
export function fixtureBuilds(connectionId: string, now: number): MockBuild[] {
  if (connectionId !== localConnectionId) {
    return [];
  }
  return [
    {
      database: 'shop',
      collection: 'orders',
      indexName: 'customerId_1',
      startedAt: now,
      opid: 1201,
    },
  ];
}

/** Progress for a build, or undefined once it has finished. */
export function buildProgress(build: MockBuild, now: number): IndexBuildProgress | undefined {
  const percent = Math.min(PERCENT, ((now - build.startedAt) / BUILD_DURATION_MS) * PERCENT);
  if (percent >= PERCENT) {
    return undefined;
  }
  return {
    collection: build.collection,
    indexName: build.indexName,
    phase: 'Scanning collection',
    progressPercent: Math.round(percent),
    opid: build.opid,
  };
}

export function findDatabase(
  catalog: readonly MockDatabase[],
  name: string,
): MockDatabase | undefined {
  return catalog.find((database) => database.name === name);
}

export function findMockCollection(
  catalog: readonly MockDatabase[],
  database: string,
  name: string,
): MockCollection | undefined {
  return findDatabase(catalog, database)?.collections.find((item) => item.info.name === name);
}

export function idKey(id: unknown): string {
  return JSON.stringify(id);
}
