import {
  MongoError,
  type ChangeStream,
  type ChangeStreamOptions,
  type Document,
  type MongoClient,
  type Timestamp,
} from 'mongodb';
import {
  AppErrorException,
  appError,
  CHANGE_PAUSE_BUFFER_LIMIT,
  CHANGE_PAUSE_BUFFER_MAX_BYTES,
  ChangeTargetSchema,
  ChangeWatchOptionsSchema,
  DEFAULT_CHANGE_BATCH_SIZE,
  DEFAULT_CHANGE_MAX_AWAIT_MS,
  type AppError,
  type ChangeEvent,
  type ChangeTarget,
  type ChangeWatchOptions,
  type ChangeWatchPhase,
  type ChangeWatchState,
} from '@mongo-gui/core';
import { mapDriverError } from '../errors';
import { readField, readRecord } from '../documents';
import { parseOperationTime, parsePipeline, parseResumeToken, toChangeEvent } from './helpers';

// Error code 286: the resume token points before the oplog window.
const CHANGE_STREAM_HISTORY_LOST = 286;
const RESUMABLE_LABEL = 'ResumableChangeStreamError';
const INVALIDATE = 'invalidate';

export interface ChangeWatchHandlers {
  readonly onEvent: (event: ChangeEvent) => void;
  // Called on every phase change, not on every event. Read state() for the counters.
  readonly onState: (state: ChangeWatchState) => void;
  readonly signal?: AbortSignal;
}

export interface ChangeWatch {
  // Stops delivering events. The cursor stays open and events are buffered.
  pause(): void;
  // Delivers the buffered events in order and returns to live delivery.
  resume(): void;
  // Closes the cursor. The promise settles once the cursor is closed.
  close(): Promise<void>;
  state(): ChangeWatchState;
}

interface ResumePoint {
  readonly resumeAfter: Document | undefined;
  readonly startAtOperationTime: Timestamp | undefined;
}

interface Session {
  readonly target: ChangeTarget;
  readonly pipeline: Document[];
  readonly options: ChangeStreamOptions;
  readonly origin: ResumePoint;
  readonly openedAt: string;
}

// Opens a change stream on a collection, a database or the deployment. The stream is created
// synchronously and read in the background. The phase is 'opening' until the first reply from the
// server, then 'live'. A server error (a standalone server, an invalid stage) moves the watch to
// 'error' with the mapped AppError. Invalid arguments throw an AppErrorException (VALIDATION).
export function openChangeWatch(
  client: MongoClient,
  target: ChangeTarget,
  options: ChangeWatchOptions,
  handlers: ChangeWatchHandlers,
): ChangeWatch {
  const session = parseSession(target, options);
  let stream: ChangeStream<Document> | undefined;
  let phase: ChangeWatchPhase = 'opening';
  let eventsSeen = 0;
  let eventsDropped = 0;
  let lastResume: Document | undefined;
  let lastResumeTokenEjson: string | undefined;
  let error: AppError | undefined;
  let finished = false;
  let resumeUsed = false;
  const pending: ChangeEvent[] = [];
  let pendingBytes = 0;

  function snapshot(): ChangeWatchState {
    return {
      phase,
      eventsSeen,
      eventsDropped,
      openedAt: session.openedAt,
      ...(lastResumeTokenEjson === undefined ? {} : { lastResumeTokenEjson }),
      ...(error === undefined ? {} : { error }),
    };
  }

  function emitState(): void {
    handlers.onState(snapshot());
  }

  function setPhase(next: ChangeWatchPhase): void {
    if (phase !== next) {
      phase = next;
      emitState();
    }
  }

  function openStream(point: ResumePoint): ChangeStream<Document> {
    const streamOptions: ChangeStreamOptions = { ...session.options };
    if (point.resumeAfter !== undefined) {
      streamOptions.resumeAfter = point.resumeAfter;
    }
    if (point.startAtOperationTime !== undefined) {
      streamOptions.startAtOperationTime = point.startAtOperationTime;
    }
    return watchTarget(client, session.target, session.pipeline, streamOptions);
  }

  function closeStream(): Promise<void> {
    return stream === undefined ? Promise.resolve() : stream.close().catch(() => undefined);
  }

  function detachSignal(): void {
    handlers.signal?.removeEventListener('abort', onAbort);
  }

  // Ends the watch in a non-error phase. An error recorded earlier keeps the 'error' phase.
  function finish(next: ChangeWatchPhase): void {
    if (finished) {
      return;
    }
    finished = true;
    detachSignal();
    setPhase(phase === 'error' ? 'error' : next);
    void closeStream();
  }

  function fail(cause: unknown): void {
    if (finished) {
      return;
    }
    finished = true;
    detachSignal();
    error = mapDriverError(cause);
    phase = 'error';
    emitState();
    void closeStream();
  }

  function buffer(event: ChangeEvent): void {
    pending.push(event);
    pendingBytes += event.sizeBytes;
    while (
      pending.length > CHANGE_PAUSE_BUFFER_LIMIT ||
      (pendingBytes > CHANGE_PAUSE_BUFFER_MAX_BYTES && pending.length > 1)
    ) {
      const dropped = pending.shift();
      if (dropped !== undefined) {
        pendingBytes -= dropped.sizeBytes;
        eventsDropped += 1;
      }
    }
  }

  // Returns true when the event ends the stream.
  function deliver(raw: Document): boolean {
    eventsSeen += 1;
    const event = toChangeEvent(raw, eventsSeen);
    const token = readRecord(raw, '_id');
    if (token !== undefined) {
      lastResume = token;
    }
    lastResumeTokenEjson = event.resumeTokenEjson;
    if (phase === 'paused') {
      buffer(event);
    } else {
      handlers.onEvent(event);
    }
    return event.operationType === INVALIDATE;
  }

  // One resume from the last token after a resumable error. Returns false when the new stream
  // could not be opened; the watch has failed by then.
  async function tryResume(): Promise<boolean> {
    await closeStream();
    const point: ResumePoint =
      lastResume === undefined
        ? session.origin
        : { resumeAfter: lastResume, startAtOperationTime: undefined };
    try {
      stream = openStream(point);
      return true;
    } catch (cause) {
      fail(cause);
      return false;
    }
  }

  async function pump(): Promise<void> {
    try {
      while (!finished) {
        const current = stream;
        if (current === undefined) {
          return;
        }
        let raw: Document | null;
        try {
          raw = await current.tryNext();
        } catch (cause) {
          if (finished) {
            return;
          }
          if (!resumeUsed && isResumable(cause)) {
            resumeUsed = true;
            if (await tryResume()) {
              continue;
            }
            return;
          }
          fail(cause);
          return;
        }
        if (finished) {
          return;
        }
        resumeUsed = false;
        setPhase(phase === 'opening' ? 'live' : phase);
        if (raw === null) {
          if (current.closed) {
            finish('closed');
            return;
          }
          continue;
        }
        if (deliver(raw)) {
          finish('closed');
          return;
        }
      }
    } catch (cause) {
      fail(cause);
    }
  }

  function onAbort(): void {
    void close();
  }

  function pause(): void {
    if (!finished && phase !== 'paused') {
      setPhase('paused');
    }
  }

  function resume(): void {
    if (finished || phase !== 'paused') {
      return;
    }
    phase = 'live';
    while (pending.length > 0) {
      const event = pending.shift();
      if (event !== undefined) {
        handlers.onEvent(event);
      }
    }
    pendingBytes = 0;
    emitState();
  }

  async function close(): Promise<void> {
    finish('closed');
    await closeStream();
  }

  try {
    stream = openStream(session.origin);
  } catch (cause) {
    throw new AppErrorException(mapDriverError(cause));
  }
  if (handlers.signal?.aborted === true) {
    void close();
  } else {
    handlers.signal?.addEventListener('abort', onAbort, { once: true });
  }
  void pump();

  return { pause, resume, close, state: snapshot };
}

function watchTarget(
  client: MongoClient,
  target: ChangeTarget,
  pipeline: Document[],
  options: ChangeStreamOptions,
): ChangeStream<Document> {
  switch (target.kind) {
    case 'collection':
      return client.db(target.database).collection(target.collection).watch(pipeline, options);
    case 'database':
      return client.db(target.database).watch(pipeline, options);
    case 'deployment':
      return client.watch(pipeline, options);
  }
}

function parseSession(target: ChangeTarget, options: ChangeWatchOptions): Session {
  const targetCheck = ChangeTargetSchema.safeParse(target);
  if (!targetCheck.success) {
    throw validation('The watch target is not valid', targetCheck.error.message);
  }
  const optionsCheck = ChangeWatchOptionsSchema.safeParse(options);
  if (!optionsCheck.success) {
    throw validation('The watch options are not valid', optionsCheck.error.message);
  }
  const parsed = optionsCheck.data;
  const pipeline = parsed.pipelineEjson === undefined ? [] : parsePipeline(parsed.pipelineEjson);
  const resumeAfter =
    parsed.resumeAfterEjson === undefined ? undefined : parseResumeToken(parsed.resumeAfterEjson);
  const startAtOperationTime =
    parsed.startAtOperationTimeEjson === undefined
      ? undefined
      : parseOperationTime(parsed.startAtOperationTimeEjson);
  const streamOptions: ChangeStreamOptions = {
    maxAwaitTimeMS: parsed.maxAwaitTimeMs ?? DEFAULT_CHANGE_MAX_AWAIT_MS,
    batchSize: parsed.batchSize ?? DEFAULT_CHANGE_BATCH_SIZE,
    ...(parsed.fullDocument === undefined ? {} : { fullDocument: parsed.fullDocument }),
    ...(parsed.fullDocumentBeforeChange === undefined
      ? {}
      : { fullDocumentBeforeChange: parsed.fullDocumentBeforeChange }),
    ...(parsed.showExpandedEvents === undefined
      ? {}
      : { showExpandedEvents: parsed.showExpandedEvents }),
  };
  return {
    target: targetCheck.data,
    pipeline,
    options: streamOptions,
    origin: { resumeAfter, startAtOperationTime },
    openedAt: new Date().toISOString(),
  };
}

function isResumable(cause: unknown): boolean {
  if (!(cause instanceof MongoError)) {
    return false;
  }
  return (
    readField(cause, 'code') === CHANGE_STREAM_HISTORY_LOST || cause.hasErrorLabel(RESUMABLE_LABEL)
  );
}

function validation(message: string, detail?: string): AppErrorException {
  return new AppErrorException(appError('VALIDATION', message, detail));
}
