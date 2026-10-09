import { BSON, MongoClient, MongoServerError, type ClientSession } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppErrorException,
  BuildInfoSchema,
  ConnPoolStatsSchema,
  HostInfoSchema,
  ServerLogSchema,
  ServerStatusTreeSchema,
  SessionListSchema,
  type AppError,
} from '@mongo-gui/core';
import {
  getBuildInfo,
  getCollStats,
  getDbStats,
  getCommandLineOptions,
  getConnPoolStats,
  getHostInfo,
  getLogComponents,
  getParameters,
  getServerLog,
  getServerStatusTree,
  getTop,
  killAllSessionsByUser,
  killSessions,
  listSessions,
} from '../index';
import {
  CONTAINER_STARTUP_TIMEOUT_MS,
  MONGO_IMAGES,
  startMongo,
  type StartedMongo,
} from '../test/mongo-container';

const DIAG_DB = 'diag_test';
const DIAG_COLLECTION = 'items';
const ITEM_COUNT = 20;
const READER_USER = 'diag_reader';
const READER_PASSWORD = 'reader-secret';
const SESSION_ADMIN_ROLE = 'diag_session_admin';
const KILLER_USER = 'diag_killer';
const KILLER_PASSWORD = 'killer-secret';
const SUITE_TIMEOUT_MS = 60_000;
// The slow read runs about 4 s without a kill. The kill arrives after SLOW_READ_LEAD_MS.
const SLOW_FILTER = { $where: 'sleep(200) || true' };
const SLOW_READ_LEAD_MS = 1000;
const INTERRUPTED_CODE = 11601;
const KILLED_SESSION_CODE = 228;

describe.each(MONGO_IMAGES)('server diagnostics on %s', (image) => {
  let mongo: StartedMongo | undefined;
  let client: MongoClient | undefined;
  let killer: MongoClient | undefined;

  beforeAll(async () => {
    mongo = await startMongo(image, { testCommands: true });
    client = new MongoClient(mongo.rootUri, { appName: 'diagnostics-test' });
    await client.connect();
    const items = client.db(DIAG_DB).collection(DIAG_COLLECTION);
    await items.insertMany(
      Array.from({ length: ITEM_COUNT }, (_, index) => ({ index, label: `item-${index}` })),
    );
    await client.db('admin').command({
      createUser: READER_USER,
      pwd: READER_PASSWORD,
      roles: [{ role: 'read', db: DIAG_DB }],
    });
    // Killing another user's sessions needs the impersonate privilege. The root role lacks it.
    await client.db('admin').command({
      createRole: SESSION_ADMIN_ROLE,
      privileges: [{ resource: { cluster: true }, actions: ['impersonate', 'killAnySession'] }],
      roles: [],
    });
    await client.db('admin').command({
      createUser: KILLER_USER,
      pwd: KILLER_PASSWORD,
      roles: [{ role: SESSION_ADMIN_ROLE, db: 'admin' }],
    });
    killer = new MongoClient(userUri(mongo.rootUri, KILLER_USER, KILLER_PASSWORD), {
      appName: 'killer-test',
    });
    await killer.connect();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await killer?.close();
    await client?.close();
    await mongo?.stop();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  function connected(): MongoClient {
    if (client === undefined) {
      throw new Error('the server was not started');
    }
    return client;
  }

  function startedMongo(): StartedMongo {
    if (mongo === undefined) {
      throw new Error('the server was not started');
    }
    return mongo;
  }

  function killerClient(): MongoClient {
    if (killer === undefined) {
      throw new Error('the killer user was not created');
    }
    return killer;
  }

  function expectedVersionTag(): string {
    return image.slice('mongo:'.length);
  }

  it(
    'reads the global log with parsed JSON lines',
    async () => {
      const log = await getServerLog(connected(), 'global');
      expect(ServerLogSchema.safeParse(log).success).toBe(true);
      expect(log.kind).toBe('global');
      expect(log.lines.length).toBeGreaterThan(0);
      // Every line of a 4.4 or newer server is JSON, so each one has a severity and a component.
      const structured = log.lines.filter((line) => line.severity !== undefined);
      expect(structured.length).toBeGreaterThan(0);
      expect(structured.every((line) => line.component !== undefined)).toBe(true);
      expect(structured.every((line) => line.message.length > 0)).toBe(true);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'reads the startup warnings as a list',
    async () => {
      const log = await getServerLog(connected(), 'startupWarnings');
      expect(ServerLogSchema.safeParse(log).success).toBe(true);
      expect(Array.isArray(log.lines)).toBe(true);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'reads the log component verbosity',
    async () => {
      const verbosity = await getLogComponents(connected());
      expect(typeof verbosity.verbosity).toBe('number');
      expect(Object.values(verbosity.components).every((level) => Number.isInteger(level))).toBe(
        true,
      );
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'lists server parameters sorted by name with EJSON values',
    async () => {
      const parameters = await getParameters(connected());
      const names = parameters.map((parameter) => parameter.name);
      expect(names).toContain('logLevel');
      expect([...names].sort()).toEqual(names);
      for (const parameter of parameters) {
        expect(() => BSON.EJSON.parse(parameter.valueEjson, { relaxed: false })).not.toThrow();
      }
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'shows the command line that started mongod',
    async () => {
      const options = await getCommandLineOptions(connected());
      expect(options.argv.some((arg) => arg.includes('mongod'))).toBe(true);
      expect(() => BSON.EJSON.parse(options.parsedEjson, { relaxed: false })).not.toThrow();
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'reads host information',
    async () => {
      const host = await getHostInfo(connected());
      expect(HostInfoSchema.safeParse(host).success).toBe(true);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'reads build information for the image version',
    async () => {
      const build = await getBuildInfo(connected());
      expect(BuildInfoSchema.safeParse(build).success).toBe(true);
      const tag = expectedVersionTag();
      expect(build.version === tag || build.version.startsWith(`${tag}.`)).toBe(true);
      expect(build.storageEngines).toContain('wiredTiger');
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'reads serverStatus as a tree without the large sections',
    async () => {
      const tree = await getServerStatusTree(connected());
      expect(ServerStatusTreeSchema.safeParse(tree).success).toBe(true);
      // serverStatus has operator-count keys that start with "$", so EJSON.parse rejects it. The
      // payload is still valid JSON, and JSON.parse reads it.
      const raw = JSON.parse(tree.rawEjson) as Record<string, unknown>;
      expect(raw).toHaveProperty('host');
      expect(raw).not.toHaveProperty('tcmalloc');
      expect(tree.stripped).toContain('tcmalloc');
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'reports connection pool statistics',
    async () => {
      const pool = await getConnPoolStats(connected());
      expect(ConnPoolStatsSchema.safeParse(pool).success).toBe(true);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'lists a namespace in top after queries',
    async () => {
      const items = connected().db(DIAG_DB).collection(DIAG_COLLECTION);
      for (let attempt = 0; attempt < 3; attempt++) {
        await items.find({ index: attempt }).toArray();
      }
      const entries = await getTop(connected());
      const entry = entries.find((candidate) => candidate.ns === `${DIAG_DB}.${DIAG_COLLECTION}`);
      expect(entry).toBeDefined();
      expect(entries.map((candidate) => candidate.ns)).not.toContain('note');
      expect(entry?.total.count ?? 0).toBeGreaterThan(0);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'reads collection stats through the catalog',
    async () => {
      const stats = await getCollStats(connected(), DIAG_DB, DIAG_COLLECTION);
      expect(stats.count).toBe(ITEM_COUNT);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'reads database stats through the diagnostics re-export',
    async () => {
      const stats = await getDbStats(connected(), DIAG_DB);
      expect(stats.db).toBe(DIAG_DB);
      expect(stats.collections).toBeGreaterThan(0);
    },
    SUITE_TIMEOUT_MS,
  );

  // The session cache flushes to config.system.sessions on a timer. The test command forces the
  // flush, so the cluster-wide read has a row to return.
  it(
    'reports the all scope with the user name once the session cache is flushed',
    async () => {
      const session = connected().startSession();
      try {
        await connected().db(DIAG_DB).collection(DIAG_COLLECTION).findOne({}, { session });
        await connected().db('admin').command({ refreshLogicalSessionCacheNow: 1 });
        const listing = await listSessions(connected(), { allUsers: true });
        expect(SessionListSchema.safeParse(listing).success).toBe(true);
        expect(listing.scope).toBe('all');
        expect(listing.fallbackReason).toBeUndefined();
        const mine = listing.sessions.find((info) => info.id === sessionHex(session));
        expect(mine).toBeDefined();
        expect(mine?.userId).toBeDefined();
        expect(mine?.user).toBe('root@admin');
      } finally {
        await endSession(session);
      }
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'lists the current session after a read in it',
    async () => {
      const session = connected().startSession();
      try {
        await connected().db(DIAG_DB).collection(DIAG_COLLECTION).findOne({}, { session });
        const listing = await listSessions(connected());
        expect(SessionListSchema.safeParse(listing).success).toBe(true);
        expect(listing.scope).toBe('local');
        expect(listing.sessions.map((info) => info.id)).toContain(sessionHex(session));
      } finally {
        await endSession(session);
      }
    },
    SUITE_TIMEOUT_MS,
  );

  // Killing an idle session does not fail its next use. The server starts a new session when a
  // known lsid comes back. The kill that stops work is the one that hits a running operation.
  it(
    'kills a session by id and interrupts its running operation',
    async () => {
      const session = connected().startSession();
      const running = runSlowRead(connected(), session);
      try {
        await sleep(SLOW_READ_LEAD_MS);
        await killSessions(connected(), [sessionHex(session)]);
        expect(isInterrupted(await running)).toBe(true);
      } finally {
        await endSession(session);
      }
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'kills every session of a user and interrupts that user running operation',
    async () => {
      const readerClient = new MongoClient(
        userUri(startedMongo().rootUri, READER_USER, READER_PASSWORD),
        { appName: 'reader-test' },
      );
      await readerClient.connect();
      const readerSession = readerClient.startSession();
      try {
        const readerRunning = runSlowRead(readerClient, readerSession);
        await sleep(SLOW_READ_LEAD_MS);
        await killAllSessionsByUser(killerClient(), [{ user: READER_USER, db: 'admin' }]);
        expect(isInterrupted(await readerRunning)).toBe(true);
      } finally {
        await endSession(readerSession);
        await readerClient.close();
      }
    },
    SUITE_TIMEOUT_MS,
  );

  it('refuses an empty list of sessions to kill', async () => {
    await expectValidationError(killSessions(connected(), []));
  });

  it('refuses an empty list of users whose sessions to kill', async () => {
    await expectValidationError(killAllSessionsByUser(connected(), []));
  });
});

function sessionHex(session: ClientSession): string {
  if (session.id === undefined) {
    throw new Error('the session has no id');
  }
  return session.id.id.toString('hex');
}

async function endSession(session: ClientSession): Promise<void> {
  await session.endSession().catch(() => undefined);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Starts a read that runs for a few seconds, and resolves with its error or undefined.
async function runSlowRead(client: MongoClient, session: ClientSession): Promise<unknown> {
  return client
    .db(DIAG_DB)
    .collection(DIAG_COLLECTION)
    .find(SLOW_FILTER, { session })
    .toArray()
    .then(
      () => undefined,
      (error: unknown) => error,
    );
}

// The error an operation reports when a kill stops it.
function isInterrupted(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = error instanceof MongoServerError ? error.code : undefined;
  return (
    code === INTERRUPTED_CODE ||
    code === KILLED_SESSION_CODE ||
    /session|interrupted/i.test(error.message)
  );
}

function userUri(rootUri: string, user: string, password: string): string {
  const url = new URL(rootUri);
  url.username = user;
  url.password = password;
  return url.toString();
}

async function expectValidationError(action: Promise<unknown>): Promise<void> {
  const error: unknown = await action.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppErrorException);
  const payload: AppError | undefined =
    error instanceof AppErrorException ? error.error : undefined;
  expect(payload?.code).toBe('VALIDATION');
}
