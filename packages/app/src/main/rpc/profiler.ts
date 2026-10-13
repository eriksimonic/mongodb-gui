import {
  groupByShape,
  rpcContract,
  type ProfileCollectionInfo,
  type ProfileEntry,
  type ProfileFilter,
  type ProfilingLevel,
  type RpcEvent,
  type SetProfilingLevelInput,
  type TailProfileOptions,
} from '@mongo-gui/core';
import {
  getProfilingLevel,
  listProfileEntries,
  profileCollectionInfo,
  setProfilingLevel,
  tailProfileEntries,
  toCanonicalEjson,
  type ProfileTail,
} from '@mongo-gui/mongo-adapter';
import { driverCall, entry, type Operation } from './operation';

/** The client a profiler call runs against. */
type ProfilerClient = Parameters<typeof getProfilingLevel>[0];

/** The adapter's profiler functions, as the router calls them. */
export interface ProfilerPort {
  level(client: ProfilerClient, database: string): Promise<ProfilingLevel>;
  setLevel(
    client: ProfilerClient,
    database: string,
    input: SetProfilingLevelInput,
  ): Promise<ProfilingLevel>;
  list(client: ProfilerClient, database: string, filter: ProfileFilter): Promise<ProfileEntry[]>;
  info(client: ProfilerClient, database: string): Promise<ProfileCollectionInfo>;
  tail(client: ProfilerClient, database: string, options: TailProfileOptions): ProfileTail;
}

export const adapterProfilerPort: ProfilerPort = {
  level: getProfilingLevel,
  setLevel: setProfilingLevel,
  list: listProfileEntries,
  info: profileCollectionInfo,
  tail: tailProfileEntries,
};

interface ActiveTail {
  readonly connectionId: string;
  readonly database: string;
  readonly tail: ProfileTail;
}

/** What the profiler service needs from the router. */
export interface ProfilerServiceDeps {
  readonly port: ProfilerPort;
  readonly getClient: (connectionId: string) => ProfilerClient;
  readonly emit: (event: RpcEvent) => void;
}

/**
 * Creates the profiler operations and the live tails behind them. The router stops tails when a
 * connection drops or a renderer resets.
 */
export function createProfilerService(deps: ProfilerServiceDeps): {
  operations(): [string, Operation][];
  stopConnection(connectionId: string): void;
  stopAll(): void;
} {
  const profiler = deps.port;
  const profilerClient = deps.getClient;
  const emit = deps.emit;
  // At most one tail per connection and database, keyed by both.
  const tails = new Map<string, ActiveTail>();

  /** Stops and forgets every tail that matches. */
  const stopTails = (matches: (active: ActiveTail) => boolean): void => {
    for (const [key, candidate] of [...tails]) {
      if (matches(candidate)) {
        candidate.tail.stop();
        tails.delete(key);
      }
    }
  };

  /** Stops every tail on the connection. */
  const stopConnection = (connectionId: string): void => {
    stopTails((active) => active.connectionId === connectionId);
  };

  /** Stops every tail. */
  const stopAll = (): void => {
    stopTails(() => true);
  };

  const startTail = (
    connectionId: string,
    database: string,
    pollMs: number,
    filter: ProfileFilter | undefined,
  ): void => {
    const client = profilerClient(connectionId);
    const options: TailProfileOptions = {
      since: new Date().toISOString(),
      pollMs,
      ...(filter === undefined ? {} : { filter }),
    };
    const tail = profiler.tail(client, database, options);
    tail.onEntries((entries) => {
      emit({
        type: 'profiler:entries',
        connectionId,
        database,
        entries: entries.map(canonicalEntry),
      });
    });
    tail.onError((error) => {
      emit({ type: 'profiler:error', connectionId, database, error });
    });
    tails.set(tailKey(connectionId, database), { connectionId, database, tail });
  };

  const stopTail = (connectionId: string, database: string): void => {
    stopTails((active) => active.connectionId === connectionId && active.database === database);
  };

  function operations(): [string, Operation][] {
    return [
      entry('profiler.level', rpcContract.profiler.level, (input) =>
        driverCall(() => profiler.level(profilerClient(input.connectionId), input.database)),
      ),
      entry('profiler.setLevel', rpcContract.profiler.setLevel, (input) =>
        driverCall(() =>
          profiler.setLevel(profilerClient(input.connectionId), input.database, {
            level: input.level,
            ...(input.slowMs === undefined ? {} : { slowMs: input.slowMs }),
            ...(input.sampleRate === undefined ? {} : { sampleRate: input.sampleRate }),
          }),
        ),
      ),
      entry('profiler.list', rpcContract.profiler.list, (input) =>
        driverCall(async () =>
          (
            await profiler.list(profilerClient(input.connectionId), input.database, input.filter)
          ).map(canonicalEntry),
        ),
      ),
      entry('profiler.shapes', rpcContract.profiler.shapes, (input) =>
        driverCall(async () => {
          const entries = await profiler.list(
            profilerClient(input.connectionId),
            input.database,
            input.filter,
          );
          return groupByShape(entries.map(canonicalEntry));
        }),
      ),
      entry('profiler.info', rpcContract.profiler.info, (input) =>
        driverCall(() => profiler.info(profilerClient(input.connectionId), input.database)),
      ),
      entry('profiler.tail', rpcContract.profiler.tail, (input) => {
        stopTail(input.connectionId, input.database);
        if (input.enabled) {
          startTail(input.connectionId, input.database, input.pollMs, input.filter);
        }
      }),
    ];
  }

  return { operations, stopConnection, stopAll };
}

function tailKey(connectionId: string, database: string): string {
  return `${connectionId}\u0000${database}`;
}

/**
 * Profile entries carry BSON values in command, locks, storage and raw. They are sent in
 * canonical extended JSON, so the renderer gets plain data with $oid and $date markers.
 */
function canonicalEntry(entry: ProfileEntry): ProfileEntry {
  return {
    ...entry,
    raw: toCanonicalEjson(entry.raw),
    ...(entry.command === undefined ? {} : { command: toCanonicalEjson(entry.command) }),
    ...(entry.locks === undefined ? {} : { locks: toCanonicalEjson(entry.locks) }),
    ...(entry.storage === undefined ? {} : { storage: toCanonicalEjson(entry.storage) }),
  };
}
