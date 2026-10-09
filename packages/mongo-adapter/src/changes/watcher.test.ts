import { EventEmitter } from 'node:events';
import { MongoError, type ChangeStreamOptions, type Document, type MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import type { ChangeEvent, ChangeWatchState } from '@mongo-gui/core';
import { openChangeWatch, type ChangeWatch } from './watcher';

// A scripted stand-in for the driver's ChangeStream. Each open takes the next script. A script
// step is a document, or an error thrown by tryNext. An exhausted script idles until close.
type Step = { readonly doc: Document } | { readonly error: unknown };

class FakeStream {
  readonly cursor = new EventEmitter();
  closed = false;
  // Test hook, run when close() is called on this stream.
  onClose: (() => void) | undefined;
  private started = false;
  private readonly steps: Step[];
  private readonly idle: Array<(value: Document | null) => void> = [];

  constructor(steps: Step[]) {
    this.steps = steps;
  }

  async tryNext(): Promise<Document | null> {
    if (!this.started) {
      this.started = true;
      this.cursor.emit('init', {});
    }
    if (this.closed) {
      return null;
    }
    const step = this.steps.shift();
    if (step === undefined) {
      return new Promise<Document | null>((resolve) => {
        this.idle.push(resolve);
      });
    }
    if ('error' in step) {
      throw step.error;
    }
    return step.doc;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const release of this.idle.splice(0)) {
      release(null);
    }
    this.onClose?.();
  }
}

interface FakeDriver {
  readonly client: MongoClient;
  readonly streams: FakeStream[];
  readonly options: ChangeStreamOptions[];
}

function fakeDriver(openings: Step[][]): FakeDriver {
  const queue = [...openings];
  const streams: FakeStream[] = [];
  const options: ChangeStreamOptions[] = [];
  const watch = (_pipeline: unknown, streamOptions: ChangeStreamOptions): FakeStream => {
    options.push(streamOptions);
    const stream = new FakeStream(queue.shift() ?? []);
    streams.push(stream);
    return stream;
  };
  const client = {
    watch,
    db: () => ({ watch, collection: () => ({ watch }) }),
  } as unknown as MongoClient;
  return { client, streams, options };
}

function insert(n: number): Document {
  return {
    _id: { _data: `token-${n}` },
    operationType: 'insert',
    ns: { db: 'shop', coll: 'orders' },
    documentKey: { _id: n },
    fullDocument: { _id: n },
  };
}

function resumable(code?: number, label?: string): MongoError {
  const error = new MongoError('the change stream failed');
  if (code !== undefined) {
    Object.assign(error, { code });
  }
  if (label !== undefined) {
    error.addErrorLabel(label);
  }
  return error;
}

const RESUMABLE = 'ResumableChangeStreamError';
const TARGET = { kind: 'collection', database: 'shop', collection: 'orders' } as const;

interface Run {
  readonly driver: FakeDriver;
  readonly events: ChangeEvent[];
  readonly states: ChangeWatchState[];
  readonly watch: ChangeWatch;
}

function run(openings: Step[][], onEvent?: (event: ChangeEvent) => void): Run {
  const driver = fakeDriver(openings);
  const events: ChangeEvent[] = [];
  const states: ChangeWatchState[] = [];
  const watch = openChangeWatch(
    driver.client,
    TARGET,
    {},
    {
      onEvent: (event) => {
        events.push(event);
        onEvent?.(event);
      },
      onState: (state) => {
        states.push(state);
      },
    },
  );
  return { driver, events, states, watch };
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('openChangeWatch resume path (fake driver)', () => {
  it('resumes from the last token after a 286 history-lost error', async () => {
    const { driver, events, watch } = run([
      [{ doc: insert(1) }, { error: resumable(286) }],
      [{ doc: insert(2) }],
    ]);
    await until(() => events.length === 2, 'two events');

    expect(driver.streams).toHaveLength(2);
    expect(driver.options[1]?.resumeAfter).toEqual({ _data: 'token-1' });
    expect(events.map((event) => event.id)).toEqual(['1', '2']);
    expect(watch.state()).toMatchObject({ phase: 'live' });
    await watch.close();
  });

  it('resumes after an error carrying the ResumableChangeStreamError label', async () => {
    const { driver, events, watch } = run([
      [{ doc: insert(1) }, { error: resumable(undefined, RESUMABLE) }],
      [{ doc: insert(2) }],
    ]);
    await until(() => events.length === 2, 'two events');

    expect(driver.options[1]?.resumeAfter).toEqual({ _data: 'token-1' });
    expect(watch.state().phase).toBe('live');
    await watch.close();
  });

  it('reopens without a resume point when the error comes before any token', async () => {
    const { driver, events, watch } = run([[{ error: resumable(286) }], [{ doc: insert(1) }]]);
    await until(() => events.length === 1, 'one event');

    expect(driver.streams).toHaveLength(2);
    expect(driver.options[1]?.resumeAfter).toBeUndefined();
    await watch.close();
  });

  it('resets the one-resume allowance after a successful read', async () => {
    const { driver, events, watch } = run([
      [{ doc: insert(1) }, { error: resumable(undefined, RESUMABLE) }],
      [{ doc: insert(2) }, { error: resumable(undefined, RESUMABLE) }],
      [{ doc: insert(3) }],
    ]);
    await until(() => events.length === 3, 'three events');

    expect(driver.streams).toHaveLength(3);
    expect(driver.options[2]?.resumeAfter).toEqual({ _data: 'token-2' });
    expect(watch.state().phase).toBe('live');
    await watch.close();
  });

  it('ends in error when the second resume also fails', async () => {
    const { driver, events, watch } = run([
      [{ doc: insert(1) }, { error: resumable(undefined, RESUMABLE) }],
      [{ error: resumable(undefined, RESUMABLE) }],
    ]);
    await until(() => watch.state().phase === 'error', 'the error phase');

    expect(driver.streams).toHaveLength(2);
    expect(events).toHaveLength(1);
    expect(watch.state().error).toBeDefined();
    await watch.close();
    expect(watch.state().phase).toBe('error');
  });

  it('fails at once on an error that is not resumable', async () => {
    const { driver, watch } = run([[{ error: new MongoError('plain failure') }]]);
    await until(() => watch.state().phase === 'error', 'the error phase');

    expect(driver.streams).toHaveLength(1);
    expect(watch.state().error?.code).toBe('CONNECTION_FAILED');
    await watch.close();
  });

  it('does not reopen a cursor when close runs while the old one is closing for a resume', async () => {
    const { driver, events, watch } = run([
      [{ doc: insert(1) }, { error: resumable(undefined, RESUMABLE) }],
      [{ doc: insert(2) }],
    ]);
    const first = driver.streams[0];
    if (first === undefined) {
      throw new Error('the first cursor was not opened');
    }
    first.onClose = () => {
      void watch.close();
    };
    await until(() => watch.state().phase === 'closed', 'the closed phase');

    expect(events).toHaveLength(1);
    expect(driver.streams).toHaveLength(1);
  });
});

describe('openChangeWatch phases and pause (fake driver)', () => {
  it('turns live on the aggregate reply, not on the first batch', async () => {
    const { watch } = run([[]]);
    await until(() => watch.state().phase === 'live', 'the live phase');

    expect(watch.state().phase).toBe('live');
    await watch.close();
  });

  it('keeps the rest of the buffer in order when a flush pauses the watch', async () => {
    const delivered: ChangeEvent[] = [];
    const driver = fakeDriver([[{ doc: insert(1) }, { doc: insert(2) }, { doc: insert(3) }]]);
    const watch: ChangeWatch = openChangeWatch(
      driver.client,
      TARGET,
      {},
      {
        onEvent: (event) => {
          delivered.push(event);
          if (delivered.length === 1) {
            watch.pause();
          }
        },
        onState: () => undefined,
      },
    );
    watch.pause();
    await until(() => watch.state().eventsSeen === 3, 'three buffered events');
    expect(delivered).toHaveLength(0);

    watch.resume();
    expect(delivered.map((event) => event.id)).toEqual(['1']);
    expect(watch.state()).toMatchObject({ phase: 'paused', eventsSeen: 3 });

    watch.resume();
    expect(delivered.map((event) => event.id)).toEqual(['1', '2', '3']);
    expect(watch.state().phase).toBe('live');
    await watch.close();
  });
});
