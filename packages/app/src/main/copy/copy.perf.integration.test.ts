import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ConnectionProfile,
  CopyMode,
  CopyOptions,
  CopyProgress,
  RpcEvent,
} from '@mongo-gui/core';
import {
  dropCollectionIfExists,
  mergeCollection,
  readBackupServerInfo,
  renameCollection,
  serverIdentity,
} from '@mongo-gui/mongo-adapter';
import type { ToolsEndpoint } from '../backup/endpoint';
import { runTool } from '../backup/tool-process';
import { createToolsRegistry } from '../tools/registry';
import { createCopyService, type CopyJobs } from './copy-service';

// Runs only against the fixture in dev/copy-perf. Start it with `bash dev/copy-perf/up.sh`, then:
//   COPY_PERF=1 pnpm exec vitest run --project integration packages/app/src/main/copy/copy.perf.integration.test.ts
const PERF = process.env['COPY_PERF'] === '1';
const SOURCE_URI = process.env['COPY_PERF_A'] ?? 'mongodb://127.0.0.1:27217/';
const TARGET_URI = process.env['COPY_PERF_B'] ?? 'mongodb://127.0.0.1:27218/';
const EXPECTED_EVENTS = 1_000_000;
const TEST_TIMEOUT_MS = 10 * 60_000;
const SOURCE_ID = 'copy-perf-a';
const TARGET_ID = 'copy-perf-b';
const SAMPLE_INTERVAL_MS = 100;
const MIB = 1024 * 1024;

const appRoot = join(__dirname, '..', '..', '..');
const toolsDir = join(appRoot, 'resources', 'mongo-tools', `${process.platform}-${process.arch}`);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function profileOf(id: string, name: string): ConnectionProfile {
  return { id, name, production: false } as unknown as ConnectionProfile;
}

function endpointOf(uri: string): ToolsEndpoint {
  return {
    uri,
    profileName: uri,
    readPreference: 'primary',
    secrets: [uri],
    status: {
      state: 'connected',
      serverVersion: '8.0.17',
      topology: 'standalone',
      hosts: [new URL(uri).host],
    },
  };
}

function copyOptions(mode: CopyMode): CopyOptions {
  return {
    sourceConnectionId: SOURCE_ID,
    targetConnectionId: TARGET_ID,
    sourceDatabase: 'shop',
    targetDatabase: 'shop',
    items: [{ source: 'events', target: 'events' }],
    mode,
    acknowledged: [],
  };
}

describe.skipIf(!PERF)('copy performance on the copy-perf fixture', () => {
  let sourceClient: MongoClient;
  let targetClient: MongoClient;
  let work: string;
  let service: CopyJobs;
  const events: RpcEvent[] = [];

  const progressOf = (jobId: string): CopyProgress[] =>
    events.flatMap((event) =>
      event.type === 'copy:progress' && event.jobId === jobId ? [event.progress] : [],
    );

  async function finish(jobId: string): Promise<CopyProgress> {
    for (;;) {
      const last = progressOf(jobId).find((progress) => progress.done);
      if (last !== undefined) return last;
      await sleep(50);
    }
  }

  // The last live position of each second of the run, for the timeline line.
  function timelineOf(jobId: string): string {
    const lastPerSecond = new Map<number, CopyProgress>();
    for (const progress of progressOf(jobId)) {
      lastPerSecond.set(Math.floor(progress.elapsedMs / 1000), progress);
    }
    return [...lastPerSecond]
      .map(
        ([second, progress]) =>
          `t=${second}s processed=${progress.processedDocuments ?? '-'} documents=${progress.documents}`,
      )
      .join(' ; ');
  }

  // The live position never decreases during the run, and it steps up at least twice before the end.
  function expectLiveProgress(jobId: string): void {
    const running = progressOf(jobId).filter((progress) => !progress.done);
    let increases = 0;
    for (let index = 1; index < running.length; index++) {
      const before = running[index - 1]?.processedDocuments ?? 0;
      const after = running[index]?.processedDocuments ?? 0;
      expect(after).toBeGreaterThanOrEqual(before);
      if (after > before) increases += 1;
    }
    expect(increases).toBeGreaterThanOrEqual(2);
  }

  // Runs one copy job and reports wall time, documents per second and the peak RSS of this process.
  async function measure(
    name: string,
    mode: CopyMode,
  ): Promise<{ final: CopyProgress; jobId: string; seconds: number; peakRssMb: number }> {
    let peak = process.memoryUsage().rss;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, SAMPLE_INTERVAL_MS);
    const started = performance.now();
    try {
      const jobId = await service.start(copyOptions(mode));
      const final = await finish(jobId);
      const seconds = (performance.now() - started) / 1000;
      const peakRssMb = Math.max(peak, process.memoryUsage().rss) / MIB;
      const perSecond = Math.round(EXPECTED_EVENTS / seconds).toLocaleString('en-US');
      // Written to stdout directly, because vitest hides console output of passing tests.
      process.stdout.write(
        `copy perf | ${name} | ${seconds.toFixed(1)} s | ${perSecond} docs per second | ` +
          `peak RSS ${peakRssMb.toFixed(0)} MB | written ${final.documents} | ` +
          `skipped ${final.skippedDocuments} | failed ${final.failedDocuments}\n`,
      );
      process.stdout.write(`copy perf timeline | ${name} | ${timelineOf(jobId)}\n`);
      return { final, jobId, seconds, peakRssMb };
    } finally {
      clearInterval(sampler);
    }
  }

  async function temporaryNames(): Promise<string[]> {
    return (await targetClient.db('shop').listCollections({}, { nameOnly: true }).toArray())
      .map((info) => info.name)
      .filter((name) => name.startsWith('__copy_'));
  }

  beforeAll(async () => {
    sourceClient = new MongoClient(SOURCE_URI, { serverSelectionTimeoutMS: 5000 });
    targetClient = new MongoClient(TARGET_URI, { serverSelectionTimeoutMS: 5000 });
    try {
      await sourceClient.connect();
      await targetClient.connect();
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      throw new Error(
        `Cannot reach the copy-perf servers at ${SOURCE_URI} and ${TARGET_URI}. ` +
          `Start them with bash dev/copy-perf/up.sh. ${reason}`,
      );
    }
    const count = await sourceClient.db('shop').collection('events').estimatedDocumentCount();
    if (count < EXPECTED_EVENTS) {
      throw new Error(
        `shop.events on ${SOURCE_URI} has ${count} documents, expected ${EXPECTED_EVENTS}. ` +
          `Seed it with bash dev/copy-perf/up.sh.`,
      );
    }
    // The target starts empty, so the first replace creates the collection.
    await targetClient.db('shop').dropDatabase();

    work = mkdtempSync(join(tmpdir(), 'copy-perf-'));
    const roots = {
      bundled: toolsDir,
      downloaded: join(work, 'downloaded'),
      tmp: join(work, 'tmp'),
    };
    mkdirSync(roots.tmp, { recursive: true });
    const registry = createToolsRegistry({
      roots,
      spawn,
      platform: process.platform,
      arch: process.arch,
    });
    const listed = await registry.list('auto');
    if (listed.resolved === undefined) throw new Error('no healthy tools install found');
    const profiles: Record<string, ConnectionProfile> = {
      [SOURCE_ID]: profileOf(SOURCE_ID, 'mongo-a'),
      [TARGET_ID]: profileOf(TARGET_ID, 'mongo-b'),
    };
    const endpoints: Record<string, ToolsEndpoint> = {
      [SOURCE_ID]: endpointOf(SOURCE_URI),
      [TARGET_ID]: endpointOf(TARGET_URI),
    };
    service = createCopyService({
      registry,
      getClient: (id) => (id === SOURCE_ID ? sourceClient : targetClient),
      getProfile: (id) => {
        const profile = profiles[id];
        if (profile === undefined) throw new Error(`no profile for ${id}`);
        return profile;
      },
      endpoint: async (id) => endpoints[id] as ToolsEndpoint,
      readServerInfo: readBackupServerInfo,
      identify: serverIdentity,
      rename: renameCollection,
      dropIfExists: dropCollectionIfExists,
      merge: mergeCollection,
      runTool,
      spawn,
      emit: (event) => events.push(event),
      now: () => Date.now(),
      tmpRoot: roots.tmp,
      platform: process.platform,
    });
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await service?.dispose();
    await sourceClient?.close();
    await targetClient?.close();
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }, TEST_TIMEOUT_MS);

  it(
    'replace into an empty target',
    async () => {
      const { final, jobId } = await measure('replace, new target', 'replace');

      expect(final).toMatchObject({ done: true, cancelled: false, documents: EXPECTED_EVENTS });
      expect(final.processedDocuments).toBe(EXPECTED_EVENTS);
      expectLiveProgress(jobId);
      expect(final.error).toBeUndefined();
      expect(await targetClient.db('shop').collection('events').countDocuments()).toBe(
        EXPECTED_EVENTS,
      );
      expect(await temporaryNames()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'replace over the existing target',
    async () => {
      const { final, jobId } = await measure('replace, existing target', 'replace');

      expect(final).toMatchObject({ done: true, cancelled: false, documents: EXPECTED_EVENTS });
      expect(final.processedDocuments).toBe(EXPECTED_EVENTS);
      expectLiveProgress(jobId);
      expect(final.error).toBeUndefined();
      expect(await targetClient.db('shop').collection('events').countDocuments()).toBe(
        EXPECTED_EVENTS,
      );
      expect(await temporaryNames()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'merge over the full target, every _id exists',
    async () => {
      const { final } = await measure('merge, full target', 'merge');

      expect(final).toMatchObject({ done: true, cancelled: false, documents: EXPECTED_EVENTS });
      expect(final.error).toBeUndefined();
      expect(await targetClient.db('shop').collection('events').countDocuments()).toBe(
        EXPECTED_EVENTS,
      );
      expect(await temporaryNames()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'insert only into the full target, every _id is a duplicate',
    async () => {
      const { final, jobId } = await measure('insert only, full target', 'insertOnly');

      expect(final).toMatchObject({
        done: true,
        cancelled: false,
        documents: 0,
        skippedDocuments: EXPECTED_EVENTS,
      });
      expect(final.processedDocuments).toBe(EXPECTED_EVENTS);
      expectLiveProgress(jobId);
      expect(final.error).toBeUndefined();
      expect(await targetClient.db('shop').collection('events').countDocuments()).toBe(
        EXPECTED_EVENTS,
      );
      expect(await temporaryNames()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
