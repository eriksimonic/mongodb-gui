import { fork, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EJSON, ObjectId } from 'bson';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppError, ShellRequest, ShellResponse } from '@mongo-gui/core';
import { ShellProcessClient } from './client';
import { startMongo, type StartedMongo } from '@mongo-gui/mongo-adapter/test';

const BUNDLE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/shell-runtime.cjs');
const DATABASE = 'shop';
const DOCUMENT_COUNT = 60;
const CONTAINER_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 30_000;
const CANCEL_BUDGET_MS = 1_000;

type Kind = ShellResponse['kind'];
type MessageOf<K extends Kind> = Extract<ShellResponse, { kind: K }>;

interface Page {
  documents: { _id?: unknown; n?: unknown }[];
  cursorHasMore: boolean;
}

function messageOf<K extends Kind>(messages: readonly ShellResponse[], kind: K): MessageOf<K> {
  const found = messages.find((message): message is MessageOf<K> => message.kind === kind);
  if (found === undefined) {
    throw new Error(`no ${kind} message in ${messages.map((message) => message.kind).join(',')}`);
  }
  return found;
}

function errorOf(messages: readonly ShellResponse[]): AppError {
  return messageOf(messages, 'error').error;
}

function pageOf(message: MessageOf<'result'>): Page {
  return EJSON.parse(message.printableEjson) as Page;
}

async function collect(iterable: AsyncIterable<ShellResponse>): Promise<ShellResponse[]> {
  const messages: ShellResponse[] = [];
  for await (const message of iterable) {
    messages.push(message);
  }
  return messages;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe.each(['mongo:8.0.17', 'mongo:6.0'])('shell runtime against %s', (image) => {
  let mongo: StartedMongo;
  let child: ChildProcess;
  let client: ShellProcessClient;
  let counter = 0;

  const nextId = (label: string): string => `${label}-${++counter}`;
  const run = (request: ShellRequest): Promise<ShellResponse[]> => collect(client.request(request));

  async function evaluate(code: string, batchSize = 50): Promise<ShellResponse[]> {
    return run({ id: nextId('eval'), kind: 'evaluate', code, batchSize });
  }

  async function next(batchSize: number): Promise<ShellResponse[]> {
    return run({ id: nextId('next'), kind: 'next', batchSize });
  }

  beforeAll(async () => {
    mongo = await startMongo(image);
    child = fork(BUNDLE_PATH, [], {
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    client = new ShellProcessClient();
    await client.spawn(() => child);
  }, CONTAINER_TIMEOUT_MS);

  afterAll(async () => {
    client.dispose();
    await mongo.stop();
  }, CONTAINER_TIMEOUT_MS);

  it(
    'connects and reports the server version and topology',
    async () => {
      const messages = await run({
        id: 'connect',
        kind: 'connect',
        uri: mongo.rootUri,
        database: DATABASE,
      });
      const connected = messageOf(messages, 'connected');
      const expectedPrefix = image === 'mongo:6.0' ? '6.0.' : '8.0.';
      expect(connected.serverVersion.startsWith(expectedPrefix)).toBe(true);
      expect(connected.topology).toBe('standalone');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'inserts 60 documents and reports an InsertManyResult',
    async () => {
      const documents = `Array.from({ length: ${DOCUMENT_COUNT} }, (_, i) => ({ i, group: i % 3, label: 'item-' + i, nested: { score: i / 2 } }))`;
      const messages = await evaluate(`db.items.insertMany(${documents})`);
      const result = messageOf(messages, 'result');
      expect(result.type).toBe('InsertManyResult');
      expect(result.hasMore).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'pages a find with batchSize 25 and continues with next',
    async () => {
      const page = messageOf(await evaluate('db.items.find()', 25), 'result');
      expect(page.type).toBe('Cursor');
      expect(page.hasMore).toBe(true);
      expect(pageOf(page).documents).toHaveLength(25);

      const second = messageOf(await next(25), 'result');
      expect(pageOf(second).documents).toHaveLength(25);
      expect(second.hasMore).toBe(true);

      const third = messageOf(await next(25), 'result');
      expect(pageOf(third).documents).toHaveLength(10);
      expect(third.hasMore).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'returns the document count of an aggregation',
    async () => {
      const result = messageOf(
        await evaluate('db.items.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }])'),
        'result',
      );
      expect(result.type).toBe('AggregationCursor');
      expect(pageOf(result).documents[0]?.n).toBe(DOCUMENT_COUNT);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'emits print output before the result of the last statement',
    async () => {
      const messages = await evaluate("print('hi'); 1 + 1");
      expect(messages.map((message) => message.kind)).toEqual(['print', 'result', 'done']);
      expect(messageOf(messages, 'print').text).toBe('hi');
      expect(EJSON.parse(messageOf(messages, 'result').printableEjson)).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports a syntax error as VALIDATION and a server rejection as COMMAND_FAILED',
    async () => {
      const syntax = await evaluate('var x = (;');
      expect(errorOf(syntax).code).toBe('VALIDATION');

      const rejected = await evaluate('db.items.find({ $bad: 1 })');
      expect(errorOf(rejected).code).toBe('COMMAND_FAILED');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'round-trips ObjectId through the printable EJSON',
    async () => {
      const result = messageOf(await evaluate('db.items.find().limit(1)'), 'result');
      expect(pageOf(result).documents[0]?._id).toBeInstanceOf(ObjectId);
      expect(result.hasMore).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'completes collection methods and collection names',
    async () => {
      const methods = messageOf(
        await run({ id: nextId('complete'), kind: 'complete', code: 'db.items.fi', position: 11 }),
        'completions',
      );
      expect(methods.items.map((item) => item.text)).toContain('db.items.find');

      const collections = messageOf(
        await run({ id: nextId('complete'), kind: 'complete', code: 'db.', position: 3 }),
        'completions',
      );
      expect(collections.items).toContainEqual({ text: 'db.items', kind: 'collection' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'samples a collection and reports the presence of each path',
    async () => {
      const schema = messageOf(
        await run({
          id: nextId('schema'),
          kind: 'sampleSchema',
          database: DATABASE,
          collection: 'items',
          size: 100,
        }),
        'schema',
      );
      expect(schema.sampled).toBe(DOCUMENT_COUNT);
      expect(schema.fields).toContainEqual({ path: '_id', types: ['ObjectId'], presence: 1 });
      // i / 2 is a whole number for even i, and the driver stores whole numbers as Int32.
      expect(schema.fields).toContainEqual({
        path: 'nested.score',
        types: ['Double', 'Int32'],
        presence: 1,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'cancels a running evaluation within a second and evaluates again afterwards',
    async () => {
      const slowId = nextId('slow');
      const slow = collect(
        client.request({ id: slowId, kind: 'evaluate', code: 'sleep(5000)', batchSize: 10 }),
      );
      await sleep(200);
      const cancelled = performance.now();
      await client.cancel(slowId);
      const slowMessages = await slow;
      expect(errorOf(slowMessages).code).toBe('CANCELLED');
      expect(performance.now() - cancelled).toBeLessThan(CANCEL_BUDGET_MS);

      const after = messageOf(await evaluate('db.getName() + ":" + (1 + 41)'), 'result');
      expect(EJSON.parse(after.printableEjson)).toBe(`${DATABASE}:42`);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'kills a long server-side $where when cancelled',
    async () => {
      // The server runs this JavaScript for five seconds unless the operation is killed.
      const spin =
        'db.items.find({ $where: "var t = Date.now(); while (Date.now() - t < 5000) {} return true;" }).toArray()';
      const spinId = nextId('spin');
      const spinning = collect(
        client.request({ id: spinId, kind: 'evaluate', code: spin, batchSize: 10 }),
      );
      await sleep(300);
      const cancelled = performance.now();
      await client.cancel(spinId);
      const spinMessages = await spinning;
      expect(errorOf(spinMessages).code).toBe('CANCELLED');
      expect(performance.now() - cancelled).toBeLessThan(CANCEL_BUDGET_MS);

      const started = performance.now();
      const count = messageOf(await evaluate('db.items.countDocuments()'), 'result');
      expect(EJSON.parse(count.printableEjson)).toBe(DOCUMENT_COUNT);
      expect(performance.now() - started).toBeLessThan(CANCEL_BUDGET_MS * 3);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports CANCELLED when an evaluation outlives its timeout',
    async () => {
      const timedOut = await run({
        id: nextId('timeout'),
        kind: 'evaluate',
        code: 'sleep(5000)',
        batchSize: 10,
        timeoutMs: 300,
      });
      expect(errorOf(timedOut).code).toBe('CANCELLED');

      const after = messageOf(await evaluate('db.getName()'), 'result');
      expect(EJSON.parse(after.printableEjson)).toBe(DATABASE);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stops the abandoned script when cancelled, so no later write lands',
    async () => {
      const script =
        'sleep(1000); db.late.insertOne({}); for (let i = 0; i < 5; i++) { sleep(300); db.late.insertOne({}); }';
      const lateId = nextId('late');
      const late = collect(
        client.request({ id: lateId, kind: 'evaluate', code: script, batchSize: 10 }),
      );
      await sleep(200);
      await client.cancel(lateId);
      expect(errorOf(await late).code).toBe('CANCELLED');
      await sleep(2000);
      const count = messageOf(await evaluate('db.late.countDocuments()'), 'result');
      expect(EJSON.parse(count.printableEjson)).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'completes after a collection whose documents hold only empty arrays',
    async () => {
      await evaluate('db.c9.insertOne({ e: [] })');
      const calls = messageOf(
        await run({ id: nextId('complete'), kind: 'complete', code: 'db.c9.find({', position: 12 }),
        'completions',
      );
      expect(calls.kind).toBe('completions');
      const keywords = messageOf(
        await run({ id: nextId('complete'), kind: 'complete', code: 'sh', position: 2 }),
        'completions',
      );
      expect(keywords.items.map((item) => item.text)).toContain('show');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports a runtime ReferenceError from the script as VALIDATION',
    async () => {
      const messages = await evaluate('missingThing + 1');
      expect(errorOf(messages).code).toBe('VALIDATION');
      expect(errorOf(messages).message).toContain('missingThing is not defined');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'tags cursor results with the request that opened the cursor',
    async () => {
      const opened = messageOf(
        await run({ id: 'open-1', kind: 'evaluate', code: 'db.items.find()', batchSize: 5 }),
        'result',
      );
      expect(opened.cursorRequestId).toBe('open-1');
      expect(opened.hasMore).toBe(true);

      const page = messageOf(await next(5), 'result');
      expect(pageOf(page).documents).toHaveLength(5);
      expect(page.cursorRequestId).toBe('open-1');

      // An empty cursor has no batch to page through, so "next" reports no more pages.
      messageOf(await evaluate('db.items.find({ i: -1 })', 5), 'result');
      const empty = messageOf(await next(5), 'result');
      expect(pageOf(empty).documents).toHaveLength(0);
      expect(empty.hasMore).toBe(false);

      expect(messageOf(await evaluate('1 + 1'), 'result').cursorRequestId).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a malformed host list without losing the current connection',
    async () => {
      const bad = await run({
        id: 'bad-host',
        kind: 'connect',
        uri: 'mongodb://admin:pw@127.0.0.1:37017,/?replicaSet=x',
      });
      expect(errorOf(bad).code).toBe('CONNECTION_FAILED');
      expect(JSON.stringify(bad)).not.toContain(':pw@');

      const alive = messageOf(await evaluate('1 + 1'), 'result');
      expect(EJSON.parse(alive.printableEjson)).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'answers an invalid message with VALIDATION and keeps running',
    async () => {
      const invalid = { id: 'bad', kind: 'evaluate' } as unknown as ShellRequest;
      const messages = await run(invalid);
      expect(errorOf(messages).code).toBe('VALIDATION');
      expect(messageOf(messages, 'done').id).toBe('bad');

      const alive = messageOf(await evaluate('1 + 1'), 'result');
      expect(EJSON.parse(alive.printableEjson)).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'exits with code 0 on disconnect',
    async () => {
      const exited = new Promise<number | null>((resolve) => {
        child.once('exit', (code) => {
          resolve(code);
        });
      });
      const messages = await run({ id: 'bye', kind: 'disconnect' });
      expect(messages.map((message) => message.kind)).toEqual(['done']);
      expect(await exited).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
