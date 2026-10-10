import {
  CHANGE_EVENT_BATCH_LIMIT,
  CHANGE_PAUSE_BUFFER_LIMIT,
  newId,
  rpcContract,
  type ChangeEvent,
  type ChangeTarget,
  type ChangeWatchOptions,
  type ChangeWatchPhase,
  type ChangeWatchPushPhase,
  type ChangeWatchState,
  type RpcClient,
  type RpcEvent,
} from '@mongo-gui/core';
import { fail, method } from './mock-support';
import type { MockDatabase } from './mock-catalog';

type Rpc = RpcClient['changes'];

/** What the change stream mock needs from the mock api around it. */
export interface MockChangesDeps {
  readonly latencyMs: number;
  requireUnlocked(): void;
  requireConnected(connectionId: string): void;
  catalogOf(connectionId: string): MockDatabase[];
  emit(event: RpcEvent): void;
}

/** Synthetic events come this often, in milliseconds. */
export const MOCK_CHANGE_TICK_MS = 500;
/** The operations the generator cycles through, in order. */
const OPERATIONS = ['insert', 'update', 'replace', 'delete'] as const;
const REFUSED_STAGES: readonly string[] = ['$out', '$merge'];

interface MockWatch {
  readonly connectionId: string;
  readonly target: ChangeTarget;
  readonly options: ChangeWatchOptions;
  readonly openedAt: string;
  phase: ChangeWatchPhase;
  eventsSeen: number;
  eventsDropped: number;
  buffer: ChangeEvent[];
  timer: ReturnType<typeof setInterval> | undefined;
  ticks: number;
  /** The collection of a collection watch existed when the watch opened. A drop ends the watch. */
  sawTarget: boolean;
}

/**
 * The change stream half of the mock api. A watch emits one synthetic event per tick for the
 * collections in its scope. Pause buffers the events as the adapter does, and resume sends them
 * in batches. Dropping the target collection sends an invalidate and closes the watch.
 */
export function createMockChanges(deps: MockChangesDeps): Rpc & {
  stopConnection(connectionId: string): void;
  stopAll(): void;
} {
  const watches = new Map<string, MockWatch>();

  function stateOf(watch: MockWatch): ChangeWatchState {
    return {
      phase: watch.phase,
      eventsSeen: watch.eventsSeen,
      eventsDropped: watch.eventsDropped,
      openedAt: watch.openedAt,
    };
  }

  function pushState(
    watchId: string,
    watch: MockWatch,
    phase: ChangeWatchPushPhase = watch.phase,
  ): void {
    deps.emit({
      type: 'changes:state',
      watchId,
      state: {
        phase,
        eventsSeen: watch.eventsSeen,
        eventsDropped: watch.eventsDropped,
      },
    });
  }

  function sendEvents(watchId: string, events: readonly ChangeEvent[]): void {
    for (let index = 0; index < events.length; index += CHANGE_EVENT_BATCH_LIMIT) {
      deps.emit({
        type: 'changes:event',
        watchId,
        events: events.slice(index, index + CHANGE_EVENT_BATCH_LIMIT),
      });
    }
  }

  function deliver(watchId: string, watch: MockWatch, event: ChangeEvent): void {
    if (watch.phase !== 'paused') {
      sendEvents(watchId, [event]);
      return;
    }
    watch.buffer.push(event);
    while (watch.buffer.length > CHANGE_PAUSE_BUFFER_LIMIT) {
      watch.buffer.shift();
      watch.eventsDropped += 1;
    }
  }

  function close(watchId: string, watch: MockWatch, phase: ChangeWatchPhase): void {
    if (watch.timer !== undefined) {
      clearInterval(watch.timer);
      watch.timer = undefined;
    }
    watch.phase = phase;
    pushState(watchId, watch);
  }

  /** The collections in a watch's scope, as database and collection names. */
  function scopeOf(watch: MockWatch): { db: string; coll: string }[] {
    const databases = deps.catalogOf(watch.connectionId);
    const target = watch.target;
    const pairs: { db: string; coll: string }[] = [];
    for (const database of databases) {
      if (target.kind !== 'deployment' && database.name !== target.database) {
        continue;
      }
      for (const collection of database.collections) {
        if (target.kind === 'collection' && collection.info.name !== target.collection) {
          continue;
        }
        pairs.push({ db: database.name, coll: collection.info.name });
      }
    }
    return pairs;
  }

  function targetExists(watch: MockWatch): boolean {
    if (watch.target.kind !== 'collection') {
      return true;
    }
    const { database, collection } = watch.target;
    return deps
      .catalogOf(watch.connectionId)
      .some(
        (item) =>
          item.name === database && item.collections.some((c) => c.info.name === collection),
      );
  }

  function tick(watchId: string, watch: MockWatch): void {
    watch.ticks += 1;
    if (watch.phase === 'opening') {
      watch.phase = 'live';
      pushState(watchId, watch);
    }
    if (!targetExists(watch)) {
      if (watch.sawTarget) {
        emitInvalidate(watchId, watch);
        close(watchId, watch, 'closed');
      }
      return;
    }
    watch.sawTarget = true;
    const scope = scopeOf(watch);
    const place = scope[watch.ticks % Math.max(scope.length, 1)];
    if (place === undefined) {
      return;
    }
    const operation = OPERATIONS[watch.ticks % OPERATIONS.length] ?? 'insert';
    const event = buildEvent(watch, operation, place);
    watch.eventsSeen += 1;
    deliver(watchId, watch, event);
  }

  function emitInvalidate(watchId: string, watch: MockWatch): void {
    const target = watch.target;
    if (target.kind !== 'collection') {
      return;
    }
    watch.eventsSeen += 1;
    const event = makeEvent(watch, watch.eventsSeen, {
      operationType: 'invalidate',
      ns: { db: target.database, coll: target.collection },
    });
    deliver(watchId, watch, event);
  }

  function buildEvent(
    watch: MockWatch,
    operation: (typeof OPERATIONS)[number],
    place: { db: string; coll: string },
  ): ChangeEvent {
    const seq = watch.eventsSeen + 1;
    const key = documentIdFor(watch.ticks);
    const withDocument = operation === 'insert' || operation === 'replace';
    const fullDocument = withDocument
      ? { _id: { $oid: key }, status: 'new', amount: watch.ticks, seq }
      : undefined;
    const fullDocumentRequested =
      watch.options.fullDocument !== undefined && watch.options.fullDocument !== 'default';
    const beforeRequested = watch.options.fullDocumentBeforeChange === 'whenAvailable';
    return makeEvent(watch, seq, {
      operationType: operation,
      ns: place,
      documentKey: { _id: { $oid: key } },
      ...(operation === 'update'
        ? {
            updateDescription: {
              updatedFields: { status: 'shipped' },
              removedFields: [],
              truncatedArrays: [],
            },
            ...(fullDocumentRequested
              ? { fullDocument: { _id: { $oid: key }, status: 'shipped', amount: watch.ticks } }
              : {}),
          }
        : {}),
      ...(fullDocument === undefined ? {} : { fullDocument }),
      ...(beforeRequested && operation !== 'insert' && operation !== 'delete'
        ? { fullDocumentBeforeChange: { _id: { $oid: key }, status: 'old' } }
        : {}),
    });
  }

  return {
    start: method(
      rpcContract.changes.start,
      deps.latencyMs,
      ({ connectionId, target, options }) => {
        deps.requireUnlocked();
        deps.requireConnected(connectionId);
        checkPipeline(options.pipelineEjson);
        const watchId = newId();
        const watch: MockWatch = {
          connectionId,
          target,
          options,
          openedAt: new Date().toISOString(),
          phase: 'opening',
          eventsSeen: 0,
          eventsDropped: 0,
          buffer: [],
          timer: undefined,
          ticks: 0,
          sawTarget: false,
        };
        watches.set(watchId, watch);
        watch.timer = setInterval(() => {
          tick(watchId, watch);
        }, MOCK_CHANGE_TICK_MS);
        return { watchId };
      },
    ),
    pause: method(rpcContract.changes.pause, deps.latencyMs, ({ watchId }) => {
      const watch = watchOf(watchId);
      if (watch.phase === 'live' || watch.phase === 'opening') {
        watch.phase = 'paused';
        pushState(watchId, watch);
      }
    }),
    resume: method(rpcContract.changes.resume, deps.latencyMs, ({ watchId }) => {
      const watch = watchOf(watchId);
      if (watch.phase !== 'paused') {
        return;
      }
      pushState(watchId, watch, 'resuming');
      const buffered = watch.buffer;
      watch.buffer = [];
      watch.phase = 'live';
      sendEvents(watchId, buffered);
      pushState(watchId, watch);
    }),
    stop: method(rpcContract.changes.stop, deps.latencyMs, ({ watchId }) => {
      const watch = watchOf(watchId);
      watches.delete(watchId);
      close(watchId, watch, 'closed');
    }),
    state: method(rpcContract.changes.state, deps.latencyMs, ({ watchId }) =>
      stateOf(watchOf(watchId)),
    ),
    stopConnection(connectionId) {
      stopWhere((watch) => watch.connectionId === connectionId);
    },
    stopAll() {
      stopWhere(() => true);
    },
  };

  function stopWhere(matches: (watch: MockWatch) => boolean): void {
    for (const [watchId, watch] of [...watches]) {
      if (matches(watch)) {
        watches.delete(watchId);
        close(watchId, watch, 'closed');
      }
    }
  }

  function watchOf(watchId: string): MockWatch {
    const watch = watches.get(watchId);
    if (watch === undefined) {
      throw fail('NOT_FOUND', 'The change watch is not open.');
    }
    return watch;
  }
}

/** Refuses what the adapter refuses. The message matches the adapter's. */
function checkPipeline(text: string | undefined): void {
  if (text === undefined || text.trim() === '') {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail('VALIDATION', 'The pipeline is not valid extended JSON');
  }
  if (!Array.isArray(parsed)) {
    throw fail('VALIDATION', 'The pipeline must be an array of stages');
  }
  const refused = findRefusedStage(parsed);
  if (refused !== undefined) {
    throw fail('VALIDATION', `${refused} is not allowed in a change stream pipeline`);
  }
}

function findRefusedStage(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRefusedStage(item);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    if (REFUSED_STAGES.includes(key)) {
      return key;
    }
    const found = findRefusedStage(child);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** A 24 character hex id, derived from the tick so the rows are stable across runs. */
function documentIdFor(tick: number): string {
  return tick.toString(16).padStart(24, '0');
}

interface EventFields {
  readonly operationType: string;
  readonly ns: { db: string; coll: string };
  readonly documentKey?: unknown;
  readonly fullDocument?: unknown;
  readonly fullDocumentBeforeChange?: unknown;
  readonly updateDescription?: unknown;
}

function makeEvent(watch: MockWatch, seq: number, fields: EventFields): ChangeEvent {
  const wall = Date.now();
  const token = { _data: `8267${(seq + watch.ticks * 1000).toString(16).padStart(20, '0')}` };
  const raw = {
    _id: token,
    operationType: fields.operationType,
    clusterTime: { $timestamp: { t: Math.floor(wall / 1000), i: seq } },
    wallTime: { $date: new Date(wall).toISOString() },
    ns: fields.ns,
    ...(fields.documentKey === undefined ? {} : { documentKey: fields.documentKey }),
    ...(fields.updateDescription === undefined
      ? {}
      : { updateDescription: fields.updateDescription }),
    ...(fields.fullDocument === undefined ? {} : { fullDocument: fields.fullDocument }),
    ...(fields.fullDocumentBeforeChange === undefined
      ? {}
      : { fullDocumentBeforeChange: fields.fullDocumentBeforeChange }),
  };
  const rawEjson = JSON.stringify(raw);
  return {
    id: String(seq),
    operationType: fields.operationType,
    resumeTokenEjson: JSON.stringify(token),
    sizeBytes: rawEjson.length,
    rawEjson,
    clusterTimeEjson: JSON.stringify(raw.clusterTime),
    wallTime: new Date(wall).toISOString(),
    ns: fields.ns,
    ...(fields.documentKey === undefined
      ? {}
      : { documentKeyEjson: JSON.stringify(fields.documentKey) }),
    ...(fields.fullDocument === undefined
      ? {}
      : { fullDocumentEjson: JSON.stringify(fields.fullDocument) }),
    ...(fields.fullDocumentBeforeChange === undefined
      ? {}
      : { fullDocumentBeforeChangeEjson: JSON.stringify(fields.fullDocumentBeforeChange) }),
    ...(fields.updateDescription === undefined
      ? {}
      : { updateDescriptionEjson: JSON.stringify(fields.updateDescription) }),
  };
}
