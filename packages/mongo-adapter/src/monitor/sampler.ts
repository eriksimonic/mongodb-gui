import type { MongoClient } from 'mongodb';
import {
  AppErrorException,
  appError,
  createRingBuffer,
  deriveSample,
  MonitorIntervalMsSchema,
  type AppError,
  type MonitorConfig,
  type MonitorSample,
  type RawServerSnapshot,
  type RingBuffer,
} from '@mongo-gui/core';
import { readString } from '../documents';
import { mapDriverError } from '../errors';

export type SampleListener = (sample: MonitorSample) => void;
export type SampleErrorListener = (error: AppError) => void;

export interface SamplerOptions {
  readonly client: MongoClient;
  readonly config: MonitorConfig;
  readonly now?: () => number;
}

type Database = ReturnType<MongoClient['db']>;

// Top-level exclusions that serverStatus accepts on 4.4 through 8.0. Nested exclusions inside
// wiredTiger are ignored by the server, so that section is returned whole.
const SERVER_STATUS_COMMAND = {
  serverStatus: 1,
  metrics: 0,
  logicalSessionRecordCache: 0,
  tcmalloc: 0,
};
const REPL_SET_STATUS_COMMAND = { replSetGetStatus: 1 };
const ASCENDING = 1;
const DESCENDING = -1;
const HELLO_COMMAND = { hello: 1 };

const BACKOFF_AFTER_ERRORS = 5;
const MAX_BACKOFF_DELAY_MS = 30_000;

export class Sampler {
  private readonly client: MongoClient;
  private readonly now: () => number;
  private readonly buffer: RingBuffer<MonitorSample>;
  private readonly sampleListeners = new Set<SampleListener>();
  private readonly errorListeners = new Set<SampleErrorListener>();
  private config: MonitorConfig;
  private running = false;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private previous: RawServerSnapshot | undefined;
  // Bumped on every start, so a sample that was in flight across a restart gets zero rates.
  private epoch = 0;
  private replicaSet: boolean | undefined;
  private consecutiveErrors = 0;

  constructor(options: SamplerOptions) {
    this.client = options.client;
    this.config = options.config;
    this.now = options.now ?? Date.now;
    this.buffer = createRingBuffer<MonitorSample>(options.config.retentionMs);
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.epoch += 1;
    this.previous = undefined;
    // A tick still in flight schedules the next one when it finishes, so starting never overlaps.
    if (!this.inFlight) {
      void this.tick();
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  samples(): MonitorSample[] {
    return this.buffer.toArray();
  }

  setInterval(intervalMs: number): void {
    const parsed = MonitorIntervalMsSchema.safeParse(intervalMs);
    if (!parsed.success) {
      throw new AppErrorException(
        appError('VALIDATION', 'The sampling interval must be between 1 and 10 seconds'),
      );
    }
    this.config = { ...this.config, intervalMs: parsed.data };
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.schedule();
    }
  }

  onSample(listener: SampleListener): () => void {
    this.sampleListeners.add(listener);
    return () => {
      this.sampleListeners.delete(listener);
    };
  }

  onError(listener: SampleErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  private async tick(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.inFlight = true;
    try {
      await this.sampleOnce();
    } finally {
      this.inFlight = false;
    }
    if (this.running) {
      this.schedule();
    }
  }

  // Never rejects. A failed sample is reported to error listeners and the sampler keeps going.
  private async sampleOnce(): Promise<void> {
    const epoch = this.epoch;
    try {
      const admin = this.client.db('admin');
      const replicaSet = await this.isReplicaSet(admin);
      const serverStatus: unknown = await admin.command(SERVER_STATUS_COMMAND);
      const replSetStatus: unknown = replicaSet
        ? await admin.command(REPL_SET_STATUS_COMMAND)
        : undefined;
      const oplogFirst = replicaSet ? await this.readOplogEdge(ASCENDING) : undefined;
      const oplogLast = replicaSet ? await this.readOplogEdge(DESCENDING) : undefined;
      const current: RawServerSnapshot = {
        at: this.now(),
        serverStatus,
        replSetStatus,
        oplogFirst,
        oplogLast,
      };
      const base = epoch === this.epoch ? this.previous : undefined;
      const sample = deriveSample(base, current);
      this.previous = current;
      this.consecutiveErrors = 0;
      this.buffer.push(sample);
      this.emitSample(sample);
    } catch (error) {
      // The next tick asks the server again whether it is a replica set member.
      this.replicaSet = undefined;
      this.consecutiveErrors += 1;
      this.emitError(mapDriverError(error));
    }
  }

  private async isReplicaSet(admin: Database): Promise<boolean> {
    if (this.replicaSet === undefined) {
      const hello: unknown = await admin.command(HELLO_COMMAND);
      this.replicaSet = readString(hello, 'setName') !== undefined;
    }
    return this.replicaSet;
  }

  // Reads the first or last oplog entry. A failed read leaves the window undefined for this tick.
  private async readOplogEdge(direction: 1 | -1): Promise<unknown> {
    try {
      const rows = await this.client
        .db('local')
        .collection('oplog.rs')
        .find({}, { projection: { ts: 1 } })
        .sort({ $natural: direction })
        .limit(1)
        .toArray();
      return rows[0];
    } catch {
      return undefined;
    }
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, this.nextDelayMs());
    this.timer.unref();
  }

  private nextDelayMs(): number {
    if (this.consecutiveErrors < BACKOFF_AFTER_ERRORS) {
      return this.config.intervalMs;
    }
    const doublings = this.consecutiveErrors - BACKOFF_AFTER_ERRORS + 1;
    return Math.min(this.config.intervalMs * 2 ** doublings, MAX_BACKOFF_DELAY_MS);
  }

  // A listener that throws must not stop sampling, so its failure is dropped here.
  private emitSample(sample: MonitorSample): void {
    for (const listener of this.sampleListeners) {
      try {
        listener(sample);
      } catch {
        // Listener failures belong to the listener, not to the sampler.
      }
    }
  }

  private emitError(error: AppError): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch {
        // Listener failures belong to the listener, not to the sampler.
      }
    }
  }
}
