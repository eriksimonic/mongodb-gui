import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openConfigPipe } from './temp-config';

const MODULE = join(dirname(fileURLToPath(import.meta.url)), 'temp-config.ts');
const YAML = 'uri: "mongodb://u:p@h/"\n';
const PIPES = 20;
const posix = process.platform !== 'win32';

// Runs in a child process with UV_THREADPOOL_SIZE=2. The test process has a default pool, so a
// stall there would not show. Exit 0 means every check passed. Otherwise the child prints the
// failure and the test sees the signal. Node 24 strips the TypeScript types of the imported module.
const CHILD = `
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const [moduleUrl, root, yaml] = process.argv.slice(1);
const { openConfigPipe } = await import(moduleUrl);
const PIPES = ${PIPES};

function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(what + ' did not finish within ' + ms + ' ms')), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function readWithCat(path) {
  return new Promise((resolve, reject) => {
    const child = spawn('cat', [path]);
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error('cat exited ' + code))));
  });
}

try {
  // Phase 1: pipes that never get a reader are disposed. An fs call must still finish.
  const idle = await within(
    Promise.all(Array.from({ length: PIPES }, () => openConfigPipe(join(root, 'idle'), yaml))),
    5000,
    'opening idle pipes',
  );
  const disposed = Promise.all(idle.map((pipe) => pipe.dispose()));
  await within(mkdir(join(root, 'probe-idle')), 1000, 'mkdir after disposing idle pipes');
  await within(disposed, 5000, 'disposing idle pipes');
  for (const pipe of idle) {
    if (existsSync(pipe.dir)) throw new Error('folder left behind: ' + pipe.dir);
  }

  // Phase 2: each pipe is read by a real cat. Each reader must get the YAML once, then EOF.
  const read = await within(
    Promise.all(Array.from({ length: PIPES }, () => openConfigPipe(join(root, 'read'), yaml))),
    5000,
    'opening read pipes',
  );
  const outputs = await within(
    Promise.all(read.map((pipe) => readWithCat(pipe.path))),
    10_000,
    'reading pipes with cat',
  );
  outputs.forEach((out, index) => {
    if (out !== yaml) throw new Error('reader ' + index + ' got ' + JSON.stringify(out));
  });
  await within(Promise.all(read.map((pipe) => pipe.dispose())), 5000, 'disposing read pipes');
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  // process.exit waits for the libuv pool threads, and a stalled pool keeps them in open().
  process.kill(process.pid, 'SIGKILL');
}
`;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'temp-config-pool-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runChild(): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', CHILD, pathToFileURL(MODULE).href, root, YAML],
      { env: { ...process.env, UV_THREADPOOL_SIZE: '2' }, timeout: 25_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        resolve({ code, output: `${stdout}${stderr}${error?.message ?? ''}` });
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.runIf(posix)('openConfigPipe with a 2-thread libuv pool', () => {
  it('keeps fs calls working after 20 idle pipes are disposed, and delivers the YAML once to 20 real readers', async () => {
    const result = await runChild();
    expect(result.code, result.output).toBe(0);
  }, 30_000);

  it('delivers the YAML once when the reader opens before the writer', async () => {
    const config = await openConfigPipe(root, YAML);
    const reading = readFile(config.path, 'utf8');
    await sleep(50);
    expect(await reading).toBe(YAML);
    await config.dispose();
  });

  it('delivers the YAML once when the writer starts before the reader', async () => {
    const config = await openConfigPipe(root, YAML);
    await sleep(100);
    expect(await readFile(config.path, 'utf8')).toBe(YAML);
    await config.dispose();
  });
});
