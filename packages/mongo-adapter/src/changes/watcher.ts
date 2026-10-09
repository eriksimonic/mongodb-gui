import {
  MongoError,
  type ChangeStream,
  type ChangeStreamOptions,
  type Document,
  type Long,
  type MongoClient,
  type MongoDBNamespace,
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
const AGGREGATE_REPLY = 'init';
// Database-level and deployment-level cursors have no collection; the driver names them this way.
const AGGREGATE_COMMAND_COLLECTION = '$cmd.aggregate';

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
  let pumping: Promise<void> = Promise.resolve();
  let activeCursor: CursorHandle | undefined;

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
    const opened = watchTarget(client, session.target, session.pipeline, streamOptions);
    activeCursor = cursorOf(opened);
    // The watch is live once the server has answered the aggregate, not on the first batch.
    // On an idle collection the first batch can take a whole maxAwaitTimeMS to arrive.
    onAggregateReply(opened, () => {
      if (phase === 'opening') {
        setPhase('live');
      }
    });
    return opened;
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
    // close() may have run while the old stream was closing. Opening now would leak a cursor.
    if (finished) {
      return false;
    }
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

  // A function call keeps TypeScript from narrowing `phase` to the value it had before a handler
  // ran, so the flush loop sees a pause made by a handler.
  function isLive(): boolean {
    return phase === 'live';
  }

  function resume(): void {
    if (finished || phase !== 'paused') {
      return;
    }
    // Delivery stops as soon as a handler pauses or closes the watch. The rest stays buffered
    // in order, so the next resume continues from the event after the one that paused it.
    setPhase('live');
    while (!finished && isLive()) {
      const event = pending.shift();
      if (event === undefined) {
        break;
      }
      pendingBytes -= event.sizeBytes;
      handlers.onEvent(event);
    }
  }

  // Marks the watch finished and closes the driver stream. The driver's close does not send
  // killCursors while a getMore is pending, so the read loop is awaited first: its getMore ends
  // within maxAwaitTimeMs. The server cursor is then killed explicitly, so it does not stay idle.
  async function close(): Promise<void> {
    finish('closed');
    await closeStream();
    await pumping;
    await killCursor(client, activeCursor);
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
  pumping = pump();

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

// The driver's cursor. Its id is zero once the cursor is exhausted, and it has no id before the
// aggregate has been answered. Both getters are public on the driver's cursor type.
interface CursorHandle {
  readonly id: Long | undefined;
  readonly namespace: MongoDBNamespace;
}

function cursorOf(stream: ChangeStream<Document>): CursorHandle | undefined {
  const cursor: unknown = readField(stream, 'cursor');
  return isCursorHandle(cursor) ? cursor : undefined;
}

function isCursorHandle(value: unknown): value is CursorHandle {
  return typeof value === 'object' && value !== null && 'id' in value && 'namespace' in value;
}

// Kills the server cursor with killCursors. Errors are ignored: the cursor may already be gone,
// and close must not fail for it.
async function killCursor(client: MongoClient, cursor: CursorHandle | undefined): Promise<void> {
  const id = cursor?.id;
  if (cursor === undefined || id === undefined || id.isZero()) {
    return;
  }
  const collection = cursor.namespace.collection ?? AGGREGATE_COMMAND_COLLECTION;
  await client
    .db(cursor.namespace.db)
    .command({ killCursors: collection, cursors: [id] })
    .catch(() => undefined);
}

interface Emitter {
  once(event: string, listener: () => void): unknown;
}

function isEmitter(value: unknown): value is Emitter {
  return (
    typeof value === 'object' &&
    value !== null &&
    'once' in value &&
    typeof value.once === 'function'
  );
}

// The driver emits 'init' when the aggregate has been answered. It emits it on its internal
// cursor, which the stream does not re-emit, so the cursor is reached through the stream.
function onAggregateReply(stream: ChangeStream<Document>, listener: () => void): void {
  const cursor: unknown = readField(stream, 'cursor');
  if (isEmitter(cursor)) {
    cursor.once(AGGREGATE_REPLY, listener);
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
