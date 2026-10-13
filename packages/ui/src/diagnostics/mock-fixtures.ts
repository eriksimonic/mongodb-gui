import type {
  ConnPoolStats,
  BuildInfo,
  HostInfo,
  LogLine,
  ServerLog,
  ServerParameter,
  SessionInfo,
  TopEntry,
} from '@mongo-gui/core';

/** A small deterministic generator, so the mock logs are the same on every run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const LOG_SPAN_MS = 2 * 60 * 60 * 1000;
const LOG_LINE_COUNT = 320;

interface LogTemplate {
  readonly severity: string;
  readonly component: string;
  readonly context: string;
  readonly id: number;
  readonly message: string;
  readonly attributes: (random: () => number) => Record<string, unknown>;
  readonly weight: number;
}

const CLIENTS = ['10.0.1.14:52214', '10.0.1.22:48910', '192.168.1.8:61002', '127.0.0.1:50311'];

const TEMPLATES: readonly LogTemplate[] = [
  {
    severity: 'I',
    component: 'NETWORK',
    context: 'listener',
    id: 22943,
    message: 'Connection accepted',
    attributes: (random) => ({
      remote: pick(CLIENTS, random),
      connectionId: 100 + Math.floor(random() * 40),
      connectionCount: 3 + Math.floor(random() * 20),
    }),
    weight: 14,
  },
  {
    severity: 'I',
    component: 'NETWORK',
    context: 'conn',
    id: 22944,
    message: 'Connection ended',
    attributes: (random) => ({
      remote: pick(CLIENTS, random),
      connectionId: 100 + Math.floor(random() * 40),
      connectionCount: 3 + Math.floor(random() * 20),
    }),
    weight: 12,
  },
  {
    severity: 'I',
    component: 'COMMAND',
    context: 'conn42',
    id: 51803,
    message: 'Slow query',
    attributes: (random) => ({
      type: 'command',
      ns: pick(['shop.orders', 'shop.products', 'shop.customers'], random),
      command: { find: 'orders', filter: { status: 'open' }, limit: 50 },
      planSummary: 'COLLSCAN',
      durationMillis: 110 + Math.floor(random() * 900),
      docsExamined: 12000 + Math.floor(random() * 8000),
      keysExamined: 0,
    }),
    weight: 6,
  },
  {
    severity: 'D1',
    component: 'COMMAND',
    context: 'conn17',
    id: 21965,
    message: 'About to run the command',
    attributes: (random) => ({
      db: 'shop',
      commandArgs: { find: 'products', filter: { sku: Math.floor(random() * 500) } },
    }),
    weight: 8,
  },
  {
    severity: 'I',
    component: 'STORAGE',
    context: 'WTCheckpointThread',
    id: 4726900,
    message: 'WiredTiger message',
    attributes: (random) => ({
      message: `[${Math.floor(random() * 1e6)}] checkpoint completed successfully`,
    }),
    weight: 6,
  },
  {
    severity: 'I',
    component: 'ACCESS',
    context: 'conn9',
    id: 5286306,
    message: 'Successfully authenticated',
    attributes: (random) => ({
      client: pick(CLIENTS, random),
      mechanism: 'SCRAM-SHA-256',
      user: pick(['siteAdmin', 'reporter'], random),
      db: 'admin',
    }),
    weight: 5,
  },
  {
    severity: 'I',
    component: 'INDEX',
    context: 'IndexBuildsCoordinator',
    id: 20345,
    message: 'Index build: done building',
    attributes: () => ({ namespace: 'shop.orders', indexName: 'status_1', buildUUID: null }),
    weight: 2,
  },
  {
    severity: 'W',
    component: 'QUERY',
    context: 'conn31',
    id: 23799,
    message: 'Query planner: many plans considered for the query',
    attributes: (random) => ({
      ns: 'shop.orders',
      candidates: 4 + Math.floor(random() * 3),
    }),
    weight: 3,
  },
  {
    severity: 'W',
    component: 'NETWORK',
    context: 'listener',
    id: 23015,
    message: 'Connection refused because too many open connections',
    attributes: () => ({ connectionCount: 819, maxIncomingConnections: 819 }),
    weight: 1,
  },
  {
    severity: 'E',
    component: 'COMMAND',
    context: 'conn44',
    id: 8000000,
    message: 'Command failed',
    attributes: () => ({
      command: { insert: 'orders' },
      error: { code: 11000, codeName: 'DuplicateKey', errmsg: 'E11000 duplicate key error' },
    }),
    weight: 1,
  },
];

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)] ?? (items[0] as T);
}

/** The server log of the mock, oldest line first, the same order getLog returns. */
export function fixtureServerLog(now: number): ServerLog {
  const random = seededRandom(20260910);
  const totalWeight = TEMPLATES.reduce((sum, item) => sum + item.weight, 0);
  const start = now - LOG_SPAN_MS;
  const lines: LogLine[] = [];
  for (let index = 0; index < LOG_LINE_COUNT; index += 1) {
    let roll = random() * totalWeight;
    const template =
      TEMPLATES.find((item) => {
        roll -= item.weight;
        return roll < 0;
      }) ?? TEMPLATES[0];
    if (template === undefined) {
      continue;
    }
    const ts = new Date(start + (LOG_SPAN_MS * index) / LOG_LINE_COUNT).toISOString();
    lines.push(structuredLine(ts, template, template.attributes(random)));
  }
  return { kind: 'global', total: LOG_LINE_COUNT + 2431, lines };
}

/** The four warnings a mongod prints at startup. */
export function fixtureStartupWarnings(now: number): ServerLog {
  const at = new Date(now - LOG_SPAN_MS).toISOString();
  const warnings: readonly [number, string][] = [
    [
      4544700,
      'Access control is not enabled for the database. Read and write access to data and configuration is unrestricted',
    ],
    [5123008, 'vm.max_map_count is too low'],
    [
      22178,
      "/sys/kernel/mm/transparent_hugepage/enabled is 'always'. We suggest setting it to 'never'",
    ],
    [4184200, 'Soft rlimits for open file descriptors too low'],
  ];
  return {
    kind: 'startupWarnings',
    total: warnings.length,
    lines: warnings.map(([id, message]) =>
      structuredLine(
        at,
        { severity: 'W', component: 'CONTROL', context: 'initandlisten', id, message },
        {},
      ),
    ),
  };
}

function structuredLine(
  ts: string,
  template: Pick<LogTemplate, 'severity' | 'component' | 'context' | 'id' | 'message'>,
  attributes: Record<string, unknown>,
): LogLine {
  const raw = JSON.stringify({
    t: { $date: ts },
    s: template.severity,
    c: template.component,
    id: template.id,
    ctx: template.context,
    msg: template.message,
    attr: attributes,
  });
  return {
    ts,
    severity: template.severity,
    component: template.component,
    id: template.id,
    context: template.context,
    message: template.message,
    attributes,
    raw,
  };
}

/** A parameter set in the shape getParameter '*' returns, sorted by name. */
export function fixtureParameters(): ServerParameter[] {
  const values: Record<string, unknown> = {
    authenticationMechanisms: 'SCRAM-SHA-1,SCRAM-SHA-256',
    connPoolMaxShardedConnsPerHost: 200,
    cursorTimeoutMillis: 600000,
    failIndexKeyTooLong: true,
    featureCompatibilityVersion: '8.0',
    internalQueryExecMaxBlockingSortBytes: 104857600,
    internalQueryPlanEvaluationMaxResults: 101,
    journalCommitInterval: 0,
    logLevel: 0,
    maxAcceptableLogicalClockDriftSecs: 60,
    notablescan: false,
    ocspEnabled: true,
    ttlMonitorEnabled: true,
    ttlMonitorSleepSecs: 60,
    tcmallocReleaseRate: 1,
    traceExceptions: false,
    wiredTigerConcurrentReadTransactions: 128,
    wiredTigerConcurrentWriteTransactions: 128,
    wiredTigerEngineRuntimeConfig: 'statistics=(fast),statistics_log=(wait=0)',
    workingSetSizeMB: 0,
  };
  return Object.entries(values)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => ({
      name,
      value: typeof value === 'object' ? undefined : value,
      valueEjson: JSON.stringify(value),
    }));
}

/** A serverStatus reply in canonical EJSON, with the tcmalloc section and metrics.commands removed. */
export function fixtureServerStatus(now: number): Record<string, unknown> {
  return {
    host: 'mongo-dev-01:27017',
    version: '8.0.4',
    process: 'mongod',
    pid: { $numberLong: '48213' },
    uptime: 7260,
    uptimeMillis: { $numberLong: '7260114' },
    localTime: { $date: { $numberLong: String(now) } },
    connections: { current: 14, available: 51186, totalCreated: { $numberLong: '903' } },
    opcounters: {
      insert: 1204,
      query: 58311,
      update: 3290,
      delete: 412,
      getmore: 1876,
      command: 90321,
    },
    network: {
      bytesIn: { $numberLong: '482910233' },
      bytesOut: { $numberLong: '1190221834' },
      numRequests: { $numberLong: '93210' },
    },
    mem: { bits: 64, resident: 1834, virtual: 4012, supported: true },
    globalLock: {
      totalTime: { $numberLong: '7260000000' },
      currentQueue: { total: 0, readers: 0, writers: 0 },
      activeClients: { total: 4, readers: 2, writers: 0 },
    },
    asserts: { regular: 0, warning: 0, msg: 0, user: 12, rollovers: 0 },
    wiredTiger: {
      cache: {
        'bytes currently in the cache': { $numberLong: '412310212' },
        'maximum bytes configured': { $numberLong: '1073741824' },
        'tracked dirty bytes in the cache': { $numberLong: '1048576' },
        'pages evicted by application threads': 0,
      },
      concurrentTransactions: {
        read: { out: 2, available: 126, totalTickets: 128 },
        write: { out: 0, available: 128, totalTickets: 128 },
      },
    },
    repl: { ismaster: true, secondary: false },
    storageEngine: { name: 'wiredTiger', supportsCommittedReads: true },
    transactions: { retriedCommandsCount: { $numberLong: '0' }, currentActive: 0 },
  };
}

export function fixtureHostInfo(): HostInfo {
  const system = {
    currentTime: '2026-10-10T08:00:00.000Z',
    hostname: 'mongo-dev-01',
    cpuAddrSize: 64,
    memSizeMB: 15976,
    numCores: 8,
    cpuArch: 'x86_64',
    numaEnabled: false,
  };
  const os = { type: 'Linux', name: 'Ubuntu 24.04 LTS', version: '6.8.0-45-generic' };
  return {
    hostname: system.hostname,
    os: { type: os.type, name: os.name, version: os.version },
    cpu: { arch: system.cpuArch, cores: system.numCores },
    memSizeMb: system.memSizeMB,
    numaEnabled: system.numaEnabled,
    rawJson: JSON.stringify({ system, os, extra: { versionString: 'Linux 6.8.0-45-generic' } }),
  };
}

export function fixtureBuildInfo(): BuildInfo {
  const info = {
    version: '8.0.4',
    gitVersion: '6a4b5b2e6bd1f2c8e1a2d3f4b5c6d7e8f9a0b1c2',
    modules: [] as string[],
    allocator: 'tcmalloc-gperf',
    javascriptEngine: 'mozjs',
    storageEngines: ['devnull', 'ephemeralForTest', 'wiredTiger'],
    bits: 64,
    maxBsonObjectSize: 16777216,
  };
  return { ...info, rawJson: JSON.stringify(info) };
}

export function fixtureTop(): TopEntry[] {
  const stat = (timeMs: number, count: number) => ({ timeMs, count });
  const entry = (
    ns: string,
    total: number,
    reads: number,
    writes: number,
    counts: readonly number[],
  ): TopEntry => ({
    ns,
    total: stat(
      total,
      counts.reduce((sum, value) => sum + value, 0),
    ),
    readLock: stat(reads, counts[0] ?? 0),
    writeLock: stat(writes, counts[3] ?? 0),
    queries: stat(total / 2, counts[0] ?? 0),
    getmore: stat(total / 10, counts[1] ?? 0),
    insert: stat(writes / 3, counts[2] ?? 0),
    update: stat(writes / 3, counts[3] ?? 0),
    remove: stat(writes / 4, counts[4] ?? 0),
    commands: stat(total / 5, counts[5] ?? 0),
  });
  return [
    entry('shop.orders', 9410, 6120, 2340, [41200, 812, 9100, 3290, 40, 2100]),
    entry('shop.products', 3188, 2904, 180, [22310, 310, 420, 150, 9, 900]),
    entry('shop.customers', 1177, 1020, 130, [6400, 120, 200, 110, 2, 480]),
    entry('admin.system.users', 14, 9, 4, [88, 12, 3, 1, 0, 40]),
    entry('config.settings', 2, 2, 0, [6, 0, 0, 0, 0, 3]),
  ];
}

export function fixtureConnPool(): ConnPoolStats {
  const hosts = {
    'mongo-dev-01:27017': { inUse: 3, available: 14, created: 27 },
    'mongo-dev-02:27017': { inUse: 1, available: 6, created: 9 },
  };
  const totals = Object.values(hosts).reduce(
    (sum, host) => ({
      inUse: sum.inUse + host.inUse,
      available: sum.available + host.available,
      created: sum.created + host.created,
    }),
    { inUse: 0, available: 0, created: 0 },
  );
  return {
    totalInUse: totals.inUse,
    totalAvailable: totals.available,
    totalCreated: totals.created,
    hosts,
    rawJson: JSON.stringify({ totalInUse: totals.inUse, hosts }),
  };
}

/** One session row with a user digest, or a cluster-only row for the all-nodes listing. */
export interface MockSession {
  readonly info: SessionInfo;
  /** Cluster rows appear only when the caller asks for every user. */
  readonly clusterOnly: boolean;
}

/** Sessions of the mock server: two users on the local node, and one cluster session. */
export function fixtureSessions(now: number): MockSession[] {
  const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const row = (
    id: string,
    user: string | undefined,
    db: string | undefined,
    minutes: number,
    clusterOnly = false,
  ): MockSession => ({
    info: {
      id,
      ...(user === undefined || db === undefined ? {} : { user: `${user}@${db}` }),
      ...(user === undefined ? {} : { name: user }),
      ...(db === undefined ? {} : { db }),
      ...(user === undefined ? {} : { userId: `${db ?? ''}.${user}` }),
      lastUse: minutesAgo(minutes),
      expired: false,
    },
    clusterOnly,
  });
  return [
    row('1f9c2a4e8b7d4c1a9e3f0a6b2d5c8e71', 'reporter', 'shop', 2),
    row('5a0e7b3d9c2f4e8a1b6d0c3e7f9a2b48', 'reporter', 'shop', 14),
    row('8c3d1f6a0e9b4d2c8a7f5e1b3d6c0a92', 'siteAdmin', 'admin', 1),
    row('b72e4a9c1d0f4b6e8a3c5d7e9f1b0c24', 'siteAdmin', 'admin', 38),
    row('e4a1c7d2f8b03e6a9c5d1b7f2e4a8c06', undefined, undefined, 90),
    row('2d6f0b8e3a1c4d7f9b2e6a0c8d4f1e35', 'etl', 'shop', 6, true),
  ];
}
