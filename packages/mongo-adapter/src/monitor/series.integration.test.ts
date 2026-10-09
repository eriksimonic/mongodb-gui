import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATALOG_SERIES, MonitorSampleSchema, type MonitorSample } from '@mongo-gui/core';
import { Sampler } from '../index';
import {
  CONTAINER_STARTUP_TIMEOUT_MS,
  MONGO_IMAGES,
  startMongo,
  type StartedMongo,
} from '../test/mongo-container';

const TEST_DB = 'series_test';
const SUITE_TIMEOUT_MS = 120_000;
const INTERVAL_MS = 1000;
const SAMPLE_WAIT_MS = 5000;
// The sampler needs two snapshots before a counter has a rate. Counters are what most series are.
const SAMPLES_NEEDED = 2;
const MIN_SERIES_ON_8_0 = 20;

/** The catalogue series a sample holds, by series id. A replica member key is cut at the @. */
function reportedIds(sample: MonitorSample): Set<string> {
  return new Set(Object.keys(sample.series).map((key) => key.split('@')[0] ?? key));
}

function nextSamples(sampler: Sampler, count: number, timeoutMs: number): Promise<MonitorSample[]> {
  return new Promise((resolve, reject) => {
    const collected: MonitorSample[] = [];
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`only ${collected.length} samples within ${timeoutMs} ms`));
    }, timeoutMs);
    const unsubscribe = sampler.onSample((sample) => {
      collected.push(sample);
      if (collected.length === count) {
        clearTimeout(timer);
        unsubscribe();
        resolve(collected);
      }
    });
  });
}

describe.each(MONGO_IMAGES)('catalogue series on %s', (image) => {
  let mongo: StartedMongo | undefined;
  let client: MongoClient | undefined;

  beforeAll(async () => {
    mongo = await startMongo(image);
    client = new MongoClient(mongo.rootUri, { appName: 'series-test' });
    await client.connect();
    await client.db(TEST_DB).collection('items').insertOne({ n: 1 });
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await client?.close();
    await mongo?.stop();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  it(
    'reports the catalogue series the server has, and every sample passes the schema',
    async () => {
      if (client === undefined) {
        throw new Error('client was not started');
      }
      const sampler = new Sampler({
        client,
        config: { intervalMs: INTERVAL_MS, retentionMs: 60_000 },
      });
      const next = nextSamples(sampler, SAMPLES_NEEDED, SAMPLE_WAIT_MS);
      sampler.start();
      let samples: MonitorSample[];
      try {
        samples = await next;
      } finally {
        sampler.stop();
      }
      for (const sample of samples) {
        expect(MonitorSampleSchema.safeParse(sample).success).toBe(true);
      }
      const latest = samples[SAMPLES_NEEDED - 1];
      if (latest === undefined) {
        throw new Error('no sample');
      }
      const ids = reportedIds(latest);
      const catalogueIds = new Set(CATALOG_SERIES.map((spec) => spec.id));
      for (const id of ids) {
        expect(catalogueIds.has(id), id).toBe(true);
      }
      // Printed so the version table in the report can be checked against a real run.
      console.log(
        `${image} reports ${ids.size} of ${catalogueIds.size} series: ${[...ids].sort().join(', ')}`,
      );

      // Ticket pools, cursors and transactions exist on every supported version.
      expect(ids.has('tickets-read-available')).toBe(true);
      expect(ids.has('conn-current')).toBe(true);
      expect(ids.has('cursor-open')).toBe(true);
      expect(ids.has('tx-open')).toBe(true);
      // A standalone server has no replication or oplog series.
      expect(ids.has('repl-lag')).toBe(false);
      expect(ids.has('oplog-window')).toBe(false);
      if (image === 'mongo:4.4' || image === 'mongo:6.0') {
        // Before 8.0 the most recent checkpoint duration is reported under wiredTiger.transaction.
        expect(ids.has('wt-checkpoint-ms')).toBe(true);
      }
      if (image.startsWith('mongo:8.0')) {
        expect(ids.size).toBeGreaterThanOrEqual(MIN_SERIES_ON_8_0);
        // The checkpoint count and duration moved under wiredTiger.checkpoint on 8.0.
        expect(ids.has('wt-checkpoints')).toBe(true);
        expect(ids.has('wt-checkpoint-ms')).toBe(true);
      }
    },
    SUITE_TIMEOUT_MS,
  );
});
