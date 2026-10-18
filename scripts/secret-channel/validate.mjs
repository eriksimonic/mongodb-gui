// Checks that mongodump and mongorestore read their --config from a pipe, so the connection URI
// never has to be written to a file.
//
// Usage: node validate.mjs <mongodump> <mongorestore> [mongodb-uri]
// Linux and macOS serve the YAML through a FIFO, Windows through a named pipe.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [dumpBin, restoreBin, baseUri = 'mongodb://127.0.0.1:27017'] = process.argv.slice(2);
if (dumpBin === undefined || restoreBin === undefined) {
  console.error('usage: node validate.mjs <mongodump> <mongorestore> [mongodb-uri]');
  process.exit(2);
}

const require = createRequire(resolve('packages/mongo-adapter/package.json'));
const { MongoClient } = require('mongodb');

const isWindows = process.platform === 'win32';
const marker = `SECRETMARKER${randomUUID().replaceAll('-', '')}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : `: ${detail}`}`);
};

/**
 * Runs a tool with its --config fed from a named pipe. Resolves with exit code, output and, on
 * Windows, how often the pipe was opened. Linux and macOS use a FIFO from mkfifo, because a Node
 * stdio pipe is a socket and a tool cannot reopen a socket as /dev/fd/3.
 */
function runTool(binary, args, { yaml, stdin }) {
  return new Promise((done, fail) => {
    let reads = 0;
    let server;
    let fifoDir;
    const pipePath = isWindows
      ? `\\\\.\\pipe\\mongo-gui-${randomUUID()}`
      : join((fifoDir = mkdtempSync(join(tmpdir(), 'sc-fifo-'))), 'config');
    const launch = () => {
      const stdio = [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'];
      const child = spawn(binary, [`--config=${pipePath}`, ...args], { stdio });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      child.on('error', fail);
      const timer = setTimeout(() => child.kill(), 60_000);
      if (!isWindows) {
        // Opening a FIFO for writing waits until the tool opens it for reading.
        open(pipePath, 'w')
          .then((handle) => handle.writeFile(yaml).finally(() => handle.close()))
          .catch(() => undefined);
      }
      if (stdin !== undefined) {
        child.stdin.on('error', () => undefined);
        stdin.pipe(child.stdin);
      }
      child.on('close', (code) => {
        clearTimeout(timer);
        server?.close();
        if (fifoDir !== undefined) rmSync(fifoDir, { recursive: true, force: true });
        done({ code, output, reads });
      });
    };
    if (isWindows) {
      server = net.createServer((socket) => {
        reads += 1;
        socket.on('error', () => undefined);
        socket.end(yaml);
      });
      server.on('error', fail);
      server.listen(pipePath, launch);
    } else {
      execFileSync('mkfifo', ['-m', '600', pipePath]);
      launch();
    }
  });
}

function filesContaining(root, text, depth = 3, found = []) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return found;
  }
  for (const name of entries) {
    const path = join(root, name);
    try {
      const info = statSync(path);
      if (info.isDirectory()) {
        if (depth > 0) filesContaining(path, text, depth - 1, found);
      } else if (info.size < 5_000_000 && readFileSync(path).includes(text)) {
        found.push(path);
      }
    } catch {
      // Files that vanish or are locked cannot hold the secret for long.
    }
  }
  return found;
}

const tmpBefore = new Set(readdirSync(tmpdir()));
const work = mkdtempSync(join(tmpdir(), 'secret-channel-'));
const archive = join(work, 'dump.archive');
const client = new MongoClient(baseUri);
try {
  await client.connect();
  const db = client.db('sc_validate');
  await db.dropDatabase();
  await db.collection('docs').insertMany(Array.from({ length: 100 }, (_, i) => ({ _id: i, n: i })));

  const yaml = `uri: ${baseUri}${baseUri.includes('?') ? '&' : '/?'}appName=${marker}\n`;

  const dump = await runTool(
    dumpBin,
    ['--db=sc_validate', '--collection=docs', `--archive=${archive}`],
    { yaml },
  );
  check('mongodump reads its config from the pipe', dump.code === 0, `exit ${dump.code}, ${dump.reads} pipe reads`);
  if (dump.code !== 0) console.log(dump.output);

  const restore = await runTool(
    restoreBin,
    ['--archive', '--nsFrom=sc_validate.docs', '--nsTo=sc_validate.restored'],
    { yaml, stdin: createReadStream(archive) },
  );
  check('mongorestore reads the config from the pipe with the archive on stdin', restore.code === 0, `exit ${restore.code}, ${restore.reads} pipe reads`);
  if (restore.code !== 0) console.log(restore.output);
  const restored = await db.collection('restored').countDocuments();
  check('the restored collection has all 100 documents', restored === 100, `${restored} documents`);

  const bad = await runTool(
    dumpBin,
    ['--db=sc_validate', '--collection=docs', `--archive=${join(work, 'bad.archive')}`],
    { yaml: 'uri: mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=2000&connectTimeoutMS=2000\n' },
  );
  check('a config with an unreachable host fails, so the pipe content is really used', bad.code !== 0, `exit ${bad.code}`);

  // Only entries that appeared during the run, since the temp dir can be huge.
  const leaks = readdirSync(tmpdir())
    .filter((name) => !tmpBefore.has(name) && !work.endsWith(name))
    .flatMap((name) => filesContaining(join(tmpdir(), name), marker));
  check('no file created in the temp dir holds the config text', leaks.length === 0, leaks.join(', '));
} catch (error) {
  check('the validation ran without an unexpected error', false, String(error));
} finally {
  await client.close().catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${process.platform}: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
