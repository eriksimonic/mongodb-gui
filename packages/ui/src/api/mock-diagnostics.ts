import {
  rpcContract,
  type CollectionStats,
  type DatabaseStats,
  type RpcClient,
  type SessionInfo,
  type SessionUserInput,
} from '@mongo-gui/core';
import { method } from './mock-support';
import {
  fixtureBuildInfo,
  fixtureConnPool,
  fixtureHostInfo,
  fixtureParameters,
  fixtureServerLog,
  fixtureServerStatus,
  fixtureSessions,
  fixtureStartupWarnings,
  fixtureTop,
  type MockSession,
} from './mock-diagnostics-fixtures';

/** What the diagnostics calls need from the mock backend. */
export interface MockDiagnosticsContext {
  readonly latencyMs: number;
  /** Throws unless the vault is unlocked and the connection is connected. */
  guard(connectionId: string): void;
  dbStats(connectionId: string, database: string): DatabaseStats;
  collStats(connectionId: string, database: string, collection: string): CollectionStats;
  now(): number;
}

/**
 * The diagnostics calls of the mock. Sessions are kept per connection, so a kill removes them
 * from the next listing, the way the server would.
 */
export function createDiagnosticsCalls(context: MockDiagnosticsContext): RpcClient['diagnostics'] {
  const { latencyMs } = context;
  const calls = rpcContract.diagnostics;
  const sessions = new Map<string, MockSession[]>();

  function sessionsOf(connectionId: string): MockSession[] {
    let rows = sessions.get(connectionId);
    if (rows === undefined) {
      rows = fixtureSessions(context.now());
      sessions.set(connectionId, rows);
    }
    return rows;
  }

  function visibleSessions(connectionId: string, allUsers: boolean): SessionInfo[] {
    return sessionsOf(connectionId)
      .filter((row) => allUsers || !row.clusterOnly)
      .map((row) => row.info);
  }

  function removeSessions(connectionId: string, matches: (info: SessionInfo) => boolean): void {
    const rows = sessionsOf(connectionId);
    sessions.set(
      connectionId,
      rows.filter((row) => !matches(row.info)),
    );
  }

  return {
    getLog: method(calls.getLog, latencyMs, ({ connectionId, kind }) => {
      context.guard(connectionId);
      const now = context.now();
      return kind === 'startupWarnings' ? fixtureStartupWarnings(now) : fixtureServerLog(now);
    }),
    cmdLineOpts: method(calls.cmdLineOpts, latencyMs, ({ connectionId }) => {
      context.guard(connectionId);
      return {
        argv: ['mongod', '--replSet', 'rs0', '--bind_ip', 'localhost', '--port', '27017'],
        parsed: {
          net: { bindIp: 'localhost', port: 27017 },
          replication: { replSetName: 'rs0' },
          security: { authorization: 'disabled' },
        },
      };
    }),
    parameters: method(calls.parameters, latencyMs, ({ connectionId }) => {
      context.guard(connectionId);
      return fixtureParameters();
    }),
    hostInfo: method(calls.hostInfo, latencyMs, ({ connectionId }) => {
      context.guard(connectionId);
      return fixtureHostInfo();
    }),
    buildInfo: method(calls.buildInfo, latencyMs, ({ connectionId }) => {
      context.guard(connectionId);
      return fixtureBuildInfo();
    }),
    serverStatus: method(calls.serverStatus, latencyMs, ({ connectionId }) => {
      context.guard(connectionId);
      return {
        at: new Date(context.now()).toISOString(),
        stripped: ['tcmalloc', 'metrics.commands'],
        document: fixtureServerStatus(context.now()),
      };
    }),
    top: method(calls.top, latencyMs, ({ connectionId }) => {
      context.guard(connectionId);
      return fixtureTop();
    }),
    dbStats: method(calls.dbStats, latencyMs, ({ connectionId, database }) => {
      context.guard(connectionId);
      return context.dbStats(connectionId, database);
    }),
    collStats: method(calls.collStats, latencyMs, ({ connectionId, database, collection }) => {
      context.guard(connectionId);
      return context.collStats(connectionId, database, collection);
    }),
    connPoolStats: method(calls.connPoolStats, latencyMs, ({ connectionId }) => {
      context.guard(connectionId);
      return fixtureConnPool();
    }),
    listSessions: method(calls.listSessions, latencyMs, ({ connectionId, allUsers }) => {
      context.guard(connectionId);
      const all = allUsers === true;
      const scope: 'all' | 'local' = all ? 'all' : 'local';
      return { scope, sessions: visibleSessions(connectionId, all) };
    }),
    killSessions: method(calls.killSessions, latencyMs, ({ connectionId, ids }) => {
      context.guard(connectionId);
      const killed = new Set(ids.map((id) => id.toLowerCase()));
      removeSessions(connectionId, (info) => killed.has(info.id.toLowerCase()));
    }),
    killAllSessionsByUser: method(
      calls.killAllSessionsByUser,
      latencyMs,
      ({ connectionId, users }) => {
        context.guard(connectionId);
        removeSessions(connectionId, (info) => users.some((user) => matchesUser(info, user)));
      },
    ),
  };
}

function matchesUser(info: SessionInfo, user: SessionUserInput): boolean {
  return info.name === user.user && info.db === user.db;
}
