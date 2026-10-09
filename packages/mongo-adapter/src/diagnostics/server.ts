import type { MongoClient } from 'mongodb';
import {
  AppErrorException,
  appError,
  type BuildInfo,
  type CommandLineOptions,
  type ConnPoolStats,
  type HostInfo,
  type OpStat,
  type ServerParameter,
  type ServerStatusTree,
  type TopEntry,
} from '@mongo-gui/core';
import {
  definedEntry,
  isPlainObject,
  readBoolean,
  readField,
  readNumber,
  readRecord,
  readString,
  readStringArray,
  type PlainObject,
} from '../documents';
import { EJSON, stringifyEjson } from '../management/ejson';

import { runAdminCommand } from './command';

export { collectionStats as getCollStats, databaseStats as getDbStats } from '../catalog';

// Fields that every command reply carries. They are not server parameters.
const REPLY_FIELDS: ReadonlySet<string> = new Set(['ok', 'operationTime']);

// Relaxed EJSON text for a whole server reply. Callers read it with JSON.parse. Dates and
// Timestamps stay as single-key wrapper objects, and Longs above 2^53 keep their $numberLong form.
function relaxedJson(value: unknown): string {
  return EJSON.stringify(value, { relaxed: true });
}
const TCMALLOC_SECTION = 'tcmalloc';
const METRICS_SECTION = 'metrics';
const METRICS_COMMANDS = 'commands';

export async function getParameters(client: MongoClient): Promise<ServerParameter[]> {
  const reply = await runAdminCommand(client, { getParameter: '*' });
  const entries = isPlainObject(reply) ? Object.entries(reply) : [];
  return entries
    .filter(([name]) => !REPLY_FIELDS.has(name) && !name.startsWith('$'))
    .map(([name, value]) => ({
      name,
      value: scalarValue(value),
      valueEjson: stringifyEjson(value),
    }))
    .sort((a, b) => compareText(a.name, b.name));
}

export async function getCommandLineOptions(client: MongoClient): Promise<CommandLineOptions> {
  const reply = await runAdminCommand(client, { getCmdLineOpts: 1 });
  const parsed = readField(reply, 'parsed');
  return {
    argv: readStringArray(reply, 'argv'),
    parsed,
    parsedEjson: stringifyEjson(parsed ?? {}),
  };
}

export async function getHostInfo(client: MongoClient): Promise<HostInfo> {
  const reply = await runAdminCommand(client, { hostInfo: 1 });
  const system = readRecord(reply, 'system');
  return {
    ...definedEntry('hostname', readString(system, 'hostname')),
    ...definedEntry('os', toOs(readRecord(reply, 'os'))),
    ...definedEntry('cpu', toCpu(system)),
    ...definedEntry('memSizeMb', readNumber(system, 'memSizeMB')),
    ...definedEntry('numaEnabled', readBoolean(system, 'numaEnabled')),
    rawJson: relaxedJson(reply),
  };
}

export async function getBuildInfo(client: MongoClient): Promise<BuildInfo> {
  const reply = await runAdminCommand(client, { buildInfo: 1 });
  const version = readString(reply, 'version');
  if (version === undefined) {
    throw new AppErrorException(appError('COMMAND_FAILED', 'The buildInfo reply has no version'));
  }
  return {
    version,
    ...definedEntry('gitVersion', readString(reply, 'gitVersion')),
    modules: readStringArray(reply, 'modules'),
    ...definedEntry('allocator', readString(reply, 'allocator')),
    ...definedEntry('javascriptEngine', readString(reply, 'javascriptEngine')),
    storageEngines: readStringArray(reply, 'storageEngines'),
    ...definedEntry('bits', readNumber(reply, 'bits')),
    ...definedEntry('maxBsonObjectSize', readNumber(reply, 'maxBsonObjectSize')),
    rawJson: relaxedJson(reply),
  };
}

// The tcmalloc section and metrics.commands are large and rarely read. They are removed here
// and their names are listed in `stripped`.
export async function getServerStatusTree(client: MongoClient): Promise<ServerStatusTree> {
  const reply = await runAdminCommand(client, { serverStatus: 1 });
  const stripped: string[] = [];
  const raw: PlainObject = {};
  for (const [section, value] of Object.entries(isPlainObject(reply) ? reply : {})) {
    if (section === TCMALLOC_SECTION) {
      stripped.push(TCMALLOC_SECTION);
      continue;
    }
    if (section === METRICS_SECTION && isPlainObject(value) && METRICS_COMMANDS in value) {
      const metrics = Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== METRICS_COMMANDS),
      );
      stripped.push(`${METRICS_SECTION}.${METRICS_COMMANDS}`);
      raw[section] = metrics;
      continue;
    }
    raw[section] = value;
  }
  return { at: new Date().toISOString(), rawJson: relaxedJson(raw), stripped };
}

export async function getConnPoolStats(client: MongoClient): Promise<ConnPoolStats> {
  const reply = await runAdminCommand(client, { connPoolStats: 1 });
  const hosts = readRecord(reply, 'hosts') ?? {};
  return {
    totalInUse: readNumber(reply, 'totalInUse') ?? 0,
    totalAvailable: readNumber(reply, 'totalAvailable') ?? 0,
    totalCreated: readNumber(reply, 'totalCreated') ?? 0,
    hosts: Object.fromEntries(
      Object.entries(hosts).map(([host, stats]) => [
        host,
        {
          inUse: readNumber(stats, 'inUse') ?? 0,
          available: readNumber(stats, 'available') ?? 0,
          created: readNumber(stats, 'created') ?? 0,
        },
      ]),
    ),
    rawJson: relaxedJson(reply),
  };
}

// The top command lists one entry per namespace. It fails on mongos, and the server's message
// reaches the caller as the error detail. The totals document also carries a "note" string,
// which is not a namespace and is skipped.
export async function getTop(client: MongoClient): Promise<TopEntry[]> {
  const reply = await runAdminCommand(client, { top: 1 });
  const totals = readRecord(reply, 'totals') ?? {};
  return Object.entries(totals)
    .filter(([, value]) => isPlainObject(value))
    .map(([ns, value]) => toTopEntry(ns, value))
    .sort((a, b) => compareText(a.ns, b.ns));
}

function scalarValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  return typeof value === 'number' ? value : undefined;
}

function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function toOs(os: PlainObject | undefined): HostInfo['os'] {
  if (os === undefined) {
    return undefined;
  }
  return {
    ...definedEntry('type', readString(os, 'type')),
    ...definedEntry('name', readString(os, 'name')),
    ...definedEntry('version', readString(os, 'version')),
  };
}

function toCpu(system: PlainObject | undefined): HostInfo['cpu'] {
  const arch = readString(system, 'cpuArch');
  const cores = readNumber(system, 'numCores');
  if (arch === undefined && cores === undefined) {
    return undefined;
  }
  return { ...definedEntry('arch', arch), ...definedEntry('cores', cores) };
}

function toTopEntry(ns: string, value: unknown): TopEntry {
  return {
    ns,
    total: toOpStat(readField(value, 'total')),
    readLock: toOpStat(readField(value, 'readLock')),
    writeLock: toOpStat(readField(value, 'writeLock')),
    queries: toOpStat(readField(value, 'queries')),
    getmore: toOpStat(readField(value, 'getmore')),
    insert: toOpStat(readField(value, 'insert')),
    update: toOpStat(readField(value, 'update')),
    remove: toOpStat(readField(value, 'remove')),
    commands: toOpStat(readField(value, 'commands')),
  };
}

function toOpStat(value: unknown): OpStat {
  return {
    time: readNumber(value, 'time') ?? 0,
    count: readNumber(value, 'count') ?? 0,
  };
}
