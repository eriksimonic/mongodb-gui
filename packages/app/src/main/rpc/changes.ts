import {
  AppErrorException,
  CHANGE_EVENT_BATCH_LIMIT,
  appError,
  rpcContract,
  type AppError,
  type ChangeEvent,
  type ChangeTarget,
  type ChangeWatchOptions,
  type ChangeWatchPushState,
  type ChangeWatchState,
  type RpcEvent,
} from '@mongo-gui/core';
import { randomUUID } from 'node:crypto';
import { openChangeWatch, type ChangeWatch } from '@mongo-gui/mongo-adapter';
import { driverCall, entry, type Operation } from './operation';

/** The client a change watch runs against. */
type ChangesClient = Parameters<typeof openChangeWatch>[0];

/** Opens a change watch. RouterDeps.openWatch takes this type, so tests can inject a fake watch. */
export type OpenChangeWatch = typeof openChangeWatch;

/** A change watch held by the router. `flush` sends the batch that is waiting to go out. */
interface ActiveChangeWatch {
  readonly connectionId: string;
  readonly watchId: string;
  readonly watch: ChangeWatch;
  readonly flush: () => void;
  /** Sends a 'resuming' phase before the watch resumes and reports 'live' itself. */
  resuming(): void;
}

/** What the changes service needs from the router. */
export interface ChangesServiceDeps {
  readonly getClient: (connectionId: string) => ChangesClient;
  readonly emit: (event: RpcEvent) => void;
  /** Defaults to the adapter's openChangeWatch. Tests inject a fake watch. */
  readonly openWatch?: OpenChangeWatch;
  /** The router's error redaction. A watch error reaches the page only through it. */
  readonly sanitize: (error: AppError) => AppError;
}

export interface ChangesService {
  operations(): [string, Operation][];
  /** Stops the watches of one connection. Called when the connection leaves the connected state. */
  stopConnection(connectionId: string): void;
  /** Stops every watch. Called on renderer reset and on vault lock. */
  stopAll(): void;
}

/** Creates the change watches behind the changes calls. A watch ends with its connection or the page. */
export function createChangesService(deps: ChangesServiceDeps): ChangesService {
  // Change watches by connection, then by watch id. A watch ends with its connection or the page.
  const changeWatches = new Map<string, Map<string, ActiveChangeWatch>>();

  /** A watch state with its error redacted, so no URI reaches the page. */
  function sanitizedWatchState(state: ChangeWatchState): ChangeWatchState {
    const { error, ...rest } = state;
    return error === undefined ? rest : { ...rest, error: deps.sanitize(error) };
  }

  /** The state the renderer sees. Errors are redacted, so no URI reaches the page. */
  function pushStateOf(state: ChangeWatchState): ChangeWatchPushState {
    return {
      phase: state.phase,
      eventsSeen: state.eventsSeen,
      eventsDropped: state.eventsDropped,
      ...(state.error === undefined ? {} : { error: deps.sanitize(state.error) }),
    };
  }

  /** Stops the watches that match, and forgets them. Each watch closes in the background. */
  const stopChangeWatches = (matches: (active: ActiveChangeWatch) => boolean): void => {
    for (const [connectionId, watches] of [...changeWatches]) {
      for (const [watchId, active] of [...watches]) {
        if (matches(active)) {
          watches.delete(watchId);
          active.flush();
          void active.watch.close().catch(() => undefined);
        }
      }
      if (watches.size === 0) {
        changeWatches.delete(connectionId);
      }
    }
  };

  /** Opens a watch on the connection and returns its id. Events are batched into changes:event. */
  const startChangeWatch = (
    connectionId: string,
    target: ChangeTarget,
    options: ChangeWatchOptions,
  ): string => {
    const client = deps.getClient(connectionId);
    const watchId = randomUUID();
    const pending: ChangeEvent[] = [];
    let flushTimer: ReturnType<typeof setImmediate> | undefined;
    const flush = (): void => {
      if (flushTimer !== undefined) {
        clearImmediate(flushTimer);
        flushTimer = undefined;
      }
      if (pending.length > 0) {
        const events = pending.splice(0, pending.length);
        deps.emit({ type: 'changes:event', watchId, events });
      }
    };
    const open = deps.openWatch ?? openChangeWatch;
    const watch = open(client, target, options, {
      onEvent(event) {
        pending.push(event);
        if (pending.length >= CHANGE_EVENT_BATCH_LIMIT) {
          flush();
        } else if (flushTimer === undefined) {
          flushTimer = setImmediate(flush);
        }
      },
      onState(state) {
        flush();
        deps.emit({ type: 'changes:state', watchId, state: pushStateOf(state) });
      },
    });
    const active: ActiveChangeWatch = {
      connectionId,
      watchId,
      watch,
      flush,
      resuming() {
        deps.emit({
          type: 'changes:state',
          watchId,
          state: { ...pushStateOf(watch.state()), phase: 'resuming' },
        });
      },
    };
    const watches = changeWatches.get(connectionId) ?? new Map<string, ActiveChangeWatch>();
    watches.set(watchId, active);
    changeWatches.set(connectionId, watches);
    return watchId;
  };

  const changeWatchOf = (watchId: string): ActiveChangeWatch => {
    for (const watches of changeWatches.values()) {
      const active = watches.get(watchId);
      if (active !== undefined) {
        return active;
      }
    }
    throw new AppErrorException(appError('NOT_FOUND', 'The change watch is not open.'));
  };

  function operations(): [string, Operation][] {
    return [
      entry('changes.start', rpcContract.changes.start, (input) =>
        driverCall(async () => ({
          watchId: startChangeWatch(input.connectionId, input.target, input.options),
        })),
      ),
      entry('changes.pause', rpcContract.changes.pause, (input) => {
        changeWatchOf(input.watchId).watch.pause();
      }),
      entry('changes.resume', rpcContract.changes.resume, (input) => {
        const active = changeWatchOf(input.watchId);
        // The watch reports 'live' from inside resume, once its buffered events are delivered.
        active.resuming();
        active.watch.resume();
      }),
      entry('changes.stop', rpcContract.changes.stop, async (input) => {
        const active = changeWatchOf(input.watchId);
        const watches = changeWatches.get(active.connectionId);
        watches?.delete(input.watchId);
        if (watches?.size === 0) {
          changeWatches.delete(active.connectionId);
        }
        active.flush();
        await active.watch.close();
      }),
      entry('changes.state', rpcContract.changes.state, (input) =>
        sanitizedWatchState(changeWatchOf(input.watchId).watch.state()),
      ),
    ];
  }

  return {
    operations,
    stopConnection(connectionId) {
      stopChangeWatches((active) => active.connectionId === connectionId);
    },
    stopAll() {
      stopChangeWatches(() => true);
    },
  };
}
