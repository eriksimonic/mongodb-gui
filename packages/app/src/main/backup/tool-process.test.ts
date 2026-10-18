import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { AppErrorException, type ToolLogLine } from '@mongo-gui/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnFn } from '../tools/probe';
import { runTool, type RunToolOptions } from './tool-process';

type FakeChild = EventEmitter & {
  pid: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdin: PassThrough | null;
  stdout: PassThrough | null;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  // Ends the output streams and emits close, as a real child does on exit.
  exit: (code: number | null, signal?: NodeJS.Signals | null) => void;
};

function fakeChild(stdio: unknown[]): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = stdio[0] === 'pipe' ? new PassThrough() : null;
  child.stdout = stdio[1] === 'pipe' ? new PassThrough() : null;
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  child.exit = (code, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.stdout?.end();
    child.stderr.end();
    // A real child emits close once its output streams are drained.
    setImmediate(() => child.emit('close', code, signal));
  };
  return child;
}

function setup(overrides: Partial<RunToolOptions> = {}) {
  const children: FakeChild[] = [];
  const spawn = vi.fn((_file: string, _args: string[], options: { stdio: unknown[] }) => {
    const child = fakeChild(options.stdio);
    children.push(child);
    return child as unknown as ChildProcess;
  });
  const lines: { parsed: ToolLogLine; text: string }[] = [];
  const options: RunToolOptions = {
    spawn: spawn as unknown as SpawnFn,
    binary: '/tools/bin/mongodump',
    args: ['--config=/tmp/tools-1/config.yaml', '--db=shop'],
    env: { PATH: '/usr/bin' },
    cwd: '/tmp/tools-1',
    secrets: [],
    onLine: (parsed, text) => lines.push({ parsed, text }),
    platform: 'linux',
    ...overrides,
  };
  const run = runTool(options);
  const child = (): FakeChild => {
    const found = children[0];
    if (!found) throw new Error('spawn was not called');
    return found;
  };
  return { run, spawn, child, lines };
}

async function rejection(promise: Promise<unknown>): Promise<AppErrorException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppErrorException) return error;
    throw error;
  }
  throw new Error('expected the run to reject');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runTool', () => {
  it('spawns without a shell, hidden, with explicit stdio', async () => {
    const { run, spawn, child } = setup();
    child().exit(0);
    await expect(run).resolves.toEqual({ exitCode: 0, signal: null, tail: [] });
    expect(spawn).toHaveBeenCalledWith(
      '/tools/bin/mongodump',
      ['--config=/tmp/tools-1/config.yaml', '--db=shop'],
      {
        cwd: '/tmp/tools-1',
        env: { PATH: '/usr/bin' },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        shell: false,
      },
    );
  });

  it('splits stderr into lines across chunk boundaries', async () => {
    const { run, child, lines } = setup();
    const stderr = child().stderr;
    stderr.write('2026-10-10T18:42:00.123+0200\twriting `shop.ord');
    stderr.write('ers` to dump/shop/orders.bson\r\n');
    stderr.write('first\n\nsec');
    // A two-byte character split between chunks still decodes.
    const accent = Buffer.from('ond é', 'utf8');
    stderr.write(accent.subarray(0, accent.length - 1));
    stderr.write(Buffer.concat([accent.subarray(accent.length - 1), Buffer.from('\nlast')]));
    child().exit(0);
    const result = await run;
    expect(lines.map((line) => line.text)).toEqual([
      '2026-10-10T18:42:00.123+0200\twriting `shop.orders` to dump/shop/orders.bson',
      'first',
      'second é',
      'last',
    ]);
    expect(lines[0]?.parsed).toEqual({
      kind: 'writing',
      namespace: 'shop.orders',
      timeseries: false,
    });
    expect(result.tail).toEqual(lines.slice(-5).map((line) => line.text));
  });

  it('caps each line at 2,000 characters', async () => {
    const { run, child, lines } = setup();
    child().stderr.write('x'.repeat(1500));
    child().stderr.write(`${'y'.repeat(1500)}\nnext\n`);
    child().exit(0);
    await run;
    expect(lines[0]?.text).toBe('x'.repeat(1500) + 'y'.repeat(500));
    expect(lines[1]?.text).toBe('next');
  });

  it('redacts URI passwords and bare secrets in lines and in the error', async () => {
    const password = 'hunter2hunter2';
    const { run, child, lines } = setup({ secrets: [password] });
    child().stderr.write(
      'Failed: error connecting to db server: mongodb://admin:hunter2hunter2@db.example:27017/\n',
    );
    child().stderr.write(`auth failed for admin with hunter2hunter2\n`);
    child().exit(1);
    const error = await rejection(run);
    for (const line of lines) expect(line.text).not.toContain(password);
    expect(lines[0]?.parsed.kind).toBe('failed');
    expect(lines[1]?.text).toBe('auth failed for admin with ***');
    expect(error.error.code).toBe('COMMAND_FAILED');
    expect(error.error.message).toBe('mongodump failed with exit code 1.');
    expect(error.error.detail).toContain('error connecting to db server');
    expect(error.error.detail).not.toContain(password);
  });

  it('uses the last five lines as detail when no Failed line was printed', async () => {
    const { run, child } = setup();
    child().stderr.write('one\ntwo\nthree\nfour\nfive\nsix\n');
    child().exit(3);
    const error = await rejection(run);
    expect(error.error).toEqual({
      code: 'COMMAND_FAILED',
      message: 'mongodump failed with exit code 3.',
      detail: 'two\nthree\nfour\nfive\nsix',
    });
  });

  it('fails a run that exits 0 after a Failed line', async () => {
    const { run, child } = setup();
    child().stderr.write('Failed: something broke\n');
    child().exit(0);
    const error = await rejection(run);
    expect(error.error.code).toBe('COMMAND_FAILED');
    expect(error.error.detail).toBe('something broke');
  });

  it('sends SIGINT on cancel, then SIGKILL after the grace period', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    const { run, child } = setup({ signal: controller.signal, killGraceMs: 5000 });
    controller.abort();
    expect(child().kill).toHaveBeenCalledWith('SIGINT');
    vi.advanceTimersByTime(4999);
    expect(child().kill).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(child().kill).toHaveBeenLastCalledWith('SIGKILL');
    child().exit(null, 'SIGKILL');
    const error = await rejection(run);
    expect(error.error).toEqual({ code: 'CANCELLED', message: 'The mongodump run was cancelled.' });
  });

  it('does not send SIGKILL when the tool stops after SIGINT', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    const { run, child } = setup({ signal: controller.signal });
    controller.abort();
    child().exit(null, 'SIGINT');
    await rejection(run);
    vi.advanceTimersByTime(10_000);
    expect(child().kill).toHaveBeenCalledTimes(1);
  });

  it('kills a tool that prints nothing within the startup time and says so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { run, child } = setup({ startupTimeoutMs: 30_000 });
    vi.advanceTimersByTime(29_999);
    expect(child().kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(child().kill).toHaveBeenCalledWith('SIGKILL');
    child().exit(null, 'SIGKILL');
    const error = await rejection(run);
    expect(error.error.code).toBe('COMMAND_FAILED');
    expect(error.error.message).toBe('mongodump printed nothing for 30 seconds and was stopped.');
  });

  it('keeps a tool that printed a line, however long it runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { run, child } = setup({ startupTimeoutMs: 30_000 });
    child().stderr.write('2026-10-18T10:00:00.000+0000\twriting shop.orders\n');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(child().kill).not.toHaveBeenCalled();
    child().exit(0);
    await run;
  });

  it('calls kill() without a signal on Windows', async () => {
    const controller = new AbortController();
    const { run, child } = setup({ signal: controller.signal, platform: 'win32' });
    controller.abort();
    expect(child().kill).toHaveBeenCalledWith();
    child().exit(1);
    expect((await rejection(run)).error.code).toBe('CANCELLED');
  });

  it('does not spawn when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { run, spawn } = setup({ signal: controller.signal });
    expect((await rejection(run)).error.code).toBe('CANCELLED');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['ENOENT', 'EACCES'])('maps a spawn %s to NOT_FOUND', async (errno) => {
    const { run, child } = setup({ binary: 'C:\\tools\\mongorestore.exe', platform: 'win32' });
    child().pid = undefined;
    child().emit('error', Object.assign(new Error(`spawn ${errno}`), { code: errno }));
    expect((await rejection(run)).error).toEqual({
      code: 'NOT_FOUND',
      message: 'The mongorestore binary is missing or not executable.',
    });
  });

  it('maps a spawn that throws to NOT_FOUND', async () => {
    const spawn = vi.fn(() => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    });
    const run = runTool({
      spawn: spawn as unknown as SpawnFn,
      binary: '/missing/mongodump',
      args: [],
      env: {},
      cwd: '/tmp',
      secrets: [],
      onLine: () => undefined,
    });
    expect((await rejection(run)).error.code).toBe('NOT_FOUND');
  });

  it('pipes stdout into the target and resolves after it finishes', async () => {
    const chunks: Buffer[] = [];
    const target = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });
    const { run, spawn, child } = setup({ stdout: target });
    expect(spawn.mock.calls[0]?.[2].stdio).toEqual(['ignore', 'pipe', 'pipe']);
    child().stdout?.write('archive ');
    child().stdout?.write('bytes');
    child().exit(0);
    await run;
    expect(Buffer.concat(chunks).toString()).toBe('archive bytes');
    expect(target.writableFinished).toBe(true);
  });

  it('pipes the source into stdin', async () => {
    const received: Buffer[] = [];
    const { run, spawn, child } = setup({ stdin: Readable.from([Buffer.from('dump data')]) });
    expect(spawn.mock.calls[0]?.[2].stdio).toEqual(['pipe', 'ignore', 'pipe']);
    child().stdin?.on('data', (chunk: Buffer) => received.push(chunk));
    child().stdin?.on('end', () => child().exit(0));
    await run;
    expect(Buffer.concat(received).toString()).toBe('dump data');
  });

  it('ignores EPIPE on stdin after an early exit and reports the exit code', async () => {
    const source = new PassThrough();
    source.write('partial');
    const { run, child } = setup({ stdin: source });
    child().stderr.write('Failed: bad archive\n');
    child().stdin?.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    child().exit(1);
    const error = await rejection(run);
    expect(error.error.code).toBe('COMMAND_FAILED');
    expect(error.error.detail).toBe('bad archive');
    expect(source.destroyed).toBe(true);
  });

  it('ignores EPIPE on stdin when the tool still succeeds', async () => {
    const { run, child } = setup({ stdin: new PassThrough() });
    child().stdin?.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    child().exit(0);
    await expect(run).resolves.toMatchObject({ exitCode: 0 });
  });

  it('reports a failed output stream after a clean exit as INTERNAL', async () => {
    const target = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
      },
    });
    const { run, child } = setup({ stdout: target });
    child().stdout?.write('bytes');
    child().exit(0);
    const error = await rejection(run);
    expect(error.error.code).toBe('INTERNAL');
    expect(error.error.detail).toContain('ENOSPC');
  });

  it('destroys the pipes on cancel', async () => {
    const controller = new AbortController();
    const source = new PassThrough();
    const target = new PassThrough();
    const { run, child } = setup({ signal: controller.signal, stdin: source, stdout: target });
    controller.abort();
    child().exit(null, 'SIGINT');
    expect((await rejection(run)).error.code).toBe('CANCELLED');
    expect(source.destroyed).toBe(true);
    expect(target.destroyed).toBe(true);
  });
});
