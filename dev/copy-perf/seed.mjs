// Seeds the copy performance fixture: shop.events (1,000,000 documents by default) on mongo-a,
// and shop.customers (10,000 documents). Plain Node ESM with the mongodb driver from the repo.
//
// Usage: node dev/copy-perf/seed.mjs [--docs N] [--uri URI] [--batch N] [--concurrency N] [--force]
// Rerun-safe: when both counts already match, it skips the seed. --force drops shop and seeds again.
import { MongoClient } from 'mongodb';

const CUSTOMER_COUNT = 10_000;
const TYPES = ['view', 'click', 'purchase', 'refund', 'signup', 'login', 'logout', 'search'];
const TAGS = ['mobile', 'desktop', 'promo', 'organic', 'paid', 'email', 'social', 'direct'];
const SOURCES = ['web', 'app', 'api'];
const COUNTRIES = ['DE', 'FR', 'US', 'GB', 'NL', 'ES', 'IT', 'SE'];
const START_MS = Date.UTC(2024, 0, 1);
const SPAN_MS = 2 * 365 * 24 * 3600 * 1000;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function positiveInteger(name, value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    console.error(`${name} must be a positive whole number, got "${value}"`);
    process.exit(2);
  }
  return number;
}

const docs = positiveInteger('--docs', option('--docs', 1_000_000));
const uri = option('--uri', 'mongodb://127.0.0.1:27217/');
const batchSize = positiveInteger('--batch', option('--batch', 5_000));
const concurrency = positiveInteger('--concurrency', option('--concurrency', 24));
const force = process.argv.includes('--force');

// Small seeded generator (mulberry32). Math.random is slower and makes runs differ.
let state = 20260101;
function random() {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (list) => list[(random() * list.length) | 0];

function eventDocument() {
  return {
    userId: (random() * 100_000) | 0,
    type: pick(TYPES),
    amount: random() * 500,
    tags: [pick(TAGS), pick(TAGS)],
    createdAt: new Date(START_MS + Math.floor(random() * SPAN_MS)),
    meta: { source: pick(SOURCES), ok: random() < 0.9, retries: (random() * 3) | 0 },
  };
}

function customerDocument(index) {
  return {
    customerId: index,
    name: `Customer ${index}`,
    country: pick(COUNTRIES),
    createdAt: new Date(START_MS + Math.floor(random() * SPAN_MS)),
  };
}

// Each worker builds its batch, then waits for the server, so `concurrency` batches are in flight.
async function insertAll(collection, total, make) {
  let next = 0;
  let written = 0;
  async function worker() {
    for (;;) {
      const start = next;
      if (start >= total) return;
      const count = Math.min(batchSize, total - start);
      next += count;
      const batch = new Array(count);
      for (let k = 0; k < count; k++) batch[k] = make(start + k);
      const result = await collection.insertMany(batch, { ordered: false });
      written += result.insertedCount;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return written;
}

const seconds = (from) => ((performance.now() - from) / 1000).toFixed(1);

const client = new MongoClient(uri, { maxPoolSize: 32, serverSelectionTimeoutMS: 15_000 });
try {
  await client.connect();
  const db = client.db('shop');
  const events = db.collection('events', { writeConcern: { w: 1, j: false } });
  const customers = db.collection('customers', { writeConcern: { w: 1, j: false } });

  if (!force) {
    const [eventCount, customerCount] = await Promise.all([
      events.estimatedDocumentCount(),
      customers.estimatedDocumentCount(),
    ]);
    if (eventCount === docs && customerCount === CUSTOMER_COUNT) {
      console.log(
        `shop.events has ${docs} documents and shop.customers has ${CUSTOMER_COUNT}, skipping. Use --force to seed again.`,
      );
      process.exit(0);
    }
  }

  console.log(`seeding ${uri} with batch=${batchSize} concurrency=${concurrency}`);
  const started = performance.now();
  await db.dropDatabase();

  const customerStart = performance.now();
  await insertAll(customers, CUSTOMER_COUNT, customerDocument);
  console.log(`shop.customers: ${CUSTOMER_COUNT} documents in ${seconds(customerStart)} s`);

  const insertStart = performance.now();
  const written = await insertAll(events, docs, eventDocument);
  const insertSeconds = (performance.now() - insertStart) / 1000;
  console.log(
    `shop.events: ${written} documents in ${insertSeconds.toFixed(1)} s, ` +
      `${Math.round(written / insertSeconds)} docs per second`,
  );

  // Indexes come last. Building them on a full collection is faster than maintaining them during inserts.
  const indexStart = performance.now();
  await events.createIndex({ userId: 1 });
  await events.createIndex({ createdAt: -1 });
  console.log(`indexes on shop.events: ${seconds(indexStart)} s`);

  const total = (performance.now() - started) / 1000;
  console.log(`total: ${total.toFixed(1)} s`);
} catch (error) {
  console.error(`seed failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
